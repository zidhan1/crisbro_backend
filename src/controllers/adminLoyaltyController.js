const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');
const bcrypt = require('bcrypt');
const {
  createAccountActivationToken,
  invalidatePendingActivationTokens,
} = require('../services/accountActivationService');
const { sendActivationEmail } = require('../services/emailService');
const {
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
} = require('../constants/categoryMapping');
const {
  syncCustomerToRunchise,
} = require('../services/runchiseCustomerSyncService');
const { recordAdminActivity } = require('../services/adminActivityLogService');
const { respondWithServerError } = require('../lib/serverError');
const { ValidationError } = require('../lib/validationError');
const { createGetSummary } = require('./adminLoyalty/summaryController');
const {
  createRedeemAdminControllers,
} = require('./adminLoyalty/redeemAdminController');
const {
  toRedemptionTrend,
  toPublicRedemptionHistory,
} = require('../lib/loyaltySummaryProjection');
const {
  REDEEM_ITEM_SELECT,
  REDEEM_ITEM_AUDIT_INCLUDE,
} = require('./adminLoyalty/redeemItemProjection');

const DEFAULT_PB1_RATE = 0.1;
const DEFAULT_REWARD_THRESHOLD = 2000;
const DEFAULT_RUNCHISE_PARENT_BRAND_ID = 750;
const DEFAULT_RUNCHISE_REDEEM_SUB_BRAND_ID = 1041;
const ADMIN_USER_ROLES = new Set(['admin', 'marketing']);
const ADMIN_USER_UPDATE_FIELDS = new Set([
  'email',
  'phone_number',
  'password',
  'role',
]);

function getPositiveEnvInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getPb1Rate() {
  const rawRate = process.env.PB1_RATE;
  if (rawRate === undefined || rawRate === '') return DEFAULT_PB1_RATE;

  const rate = Number(rawRate);
  if (!Number.isFinite(rate) || rate < 0) return DEFAULT_PB1_RATE;

  return rate > 1 ? rate / 100 : rate;
}

function addRedeemPriceBreakdown(item) {
  const price = Number(item.menu_item?.price ?? 0);
  const pb1Rate = getPb1Rate();
  const pb1Amount = Math.round(price * pb1Rate);

  return {
    ...item,
    pb1_rate: pb1Rate,
    pb1_amount: pb1Amount,
    price_with_pb1: Math.round(price + pb1Amount),
  };
}

function getDefaultRewardThreshold() {
  const threshold = Number(
    process.env.DEFAULT_REWARD_THRESHOLD ?? DEFAULT_REWARD_THRESHOLD,
  );
  return Number.isInteger(threshold) && threshold > 0
    ? threshold
    : DEFAULT_REWARD_THRESHOLD;
}

async function sendCustomerActivationLink(customer) {
  const email = customer?.user?.email;

  if (!email) {
    return {
      sent: false,
      skipped: true,
      reason: 'Customer tidak memiliki email',
    };
  }

  await invalidatePendingActivationTokens(customer.user.id, 'activation');

  const { activationUrl, expiresAt } = await createAccountActivationToken(
    customer.user.id,
    'activation',
  );

  return sendActivationEmail({
    to: email,
    customerName: customer.name,
    phoneNumber: customer.phone_number,
    activationUrl,
    expiresAt,
  });
}

function getRedeemCatalogConfig() {
  return {
    parentBrandRunchiseId: getPositiveEnvInt(
      'RUNCHISE_PARENT_BRAND_ID',
      DEFAULT_RUNCHISE_PARENT_BRAND_ID,
    ),
    redeemSubBrandRunchiseId: getPositiveEnvInt(
      'RUNCHISE_REDEEM_SUB_BRAND_ID',
      DEFAULT_RUNCHISE_REDEEM_SUB_BRAND_ID,
    ),
  };
}

function getAdminCustomerInclude() {
  return {
    user: {
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        activation_status: true,
        activated_at: true,
      },
    },
    brand: { select: { id: true, name: true } },
    owner_location: {
      select: { id: true, name: true, city: true, runchise_id: true },
    },
    customer_locations: {
      select: {
        location_id: true,
        location: { select: { id: true, name: true, city: true } },
      },
    },
    customer_point: true,
  };
}

async function getCustomerAuditSnapshot(id, tx = prisma) {
  return tx.customer.findUnique({
    where: { id },
    include: getAdminCustomerInclude(),
  });
}

function comparableAuditValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (
    value &&
    typeof value === 'object' &&
    value.constructor?.name === 'Decimal'
  ) {
    return value.toString();
  }
  return value ?? null;
}

function auditValuesEqual(before, after) {
  return (
    JSON.stringify(comparableAuditValue(before)) ===
    JSON.stringify(comparableAuditValue(after))
  );
}

function sortedLocationIds(customer) {
  return (customer?.customer_locations ?? [])
    .map((location) => Number(location.location_id))
    .filter((locationId) => Number.isInteger(locationId))
    .sort((a, b) => a - b);
}

function getActualCustomerChangedFields({
  before,
  after,
  customerFields = [],
  userFields = [],
  pointFields = [],
  locationIdsTouched = false,
}) {
  const changedFields = [];

  for (const field of customerFields) {
    if (field === 'last_updated_by_id') continue;
    if (!auditValuesEqual(before?.[field], after?.[field])) {
      changedFields.push(field);
    }
  }

  for (const field of userFields) {
    if (!auditValuesEqual(before?.user?.[field], after?.user?.[field])) {
      changedFields.push(`user.${field}`);
    }
  }

  for (const field of pointFields) {
    if (
      !auditValuesEqual(
        before?.customer_point?.[field],
        after?.customer_point?.[field],
      )
    ) {
      changedFields.push(`point.${field}`);
    }
  }

  if (
    locationIdsTouched &&
    !auditValuesEqual(sortedLocationIds(before), sortedLocationIds(after))
  ) {
    changedFields.push('location_ids');
  }

  return changedFields;
}

function badRequest(res, message) {
  return res.status(400).json({ message });
}

function parsePositiveInt(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new ValidationError(`${fieldName} wajib diisi`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ValidationError(`${fieldName} harus berupa integer positif`);
  }

  return number;
}

function parseNonNegativeInt(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new ValidationError(`${fieldName} wajib diisi`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ValidationError(`${fieldName} harus berupa integer non-negatif`);
  }

  return number;
}

function parseBoolean(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new ValidationError(`${fieldName} wajib diisi`);
  }

  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new ValidationError(`${fieldName} harus berupa boolean`);
}

function parseOptionalString(value, fieldName, maxLength = 255) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new ValidationError(`${fieldName} harus berupa string`);

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${fieldName} maksimal ${maxLength} karakter`);
  }

  return trimmed || null;
}

function parseOptionalEmail(value, fieldName = 'email', maxLength = 255) {
  const email = parseOptionalString(value, fieldName, maxLength);
  if (!email) return email;

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    throw new ValidationError(`${fieldName} harus berupa email valid`);
  }

  return email.toLowerCase();
}

function parseRequiredString(value, fieldName, maxLength = 255) {
  const parsed = parseOptionalString(value, fieldName, maxLength);
  if (!parsed) throw new ValidationError(`${fieldName} wajib diisi`);
  return parsed;
}

function parseSortOrder(value, fallback = 'asc') {
  return value === 'asc' || value === 'desc' ? value : fallback;
}

function buildAdminUserOrderBy(sortBy, sortOrder) {
  const order = parseSortOrder(
    sortOrder,
    sortBy === 'created_at' ? 'desc' : 'asc',
  );
  const map = {
    email: [{ email: order }, { id: 'asc' }],
    phone_number: [{ phone_number: order }, { id: 'asc' }],
    role: [{ role: order }, { created_at: 'desc' }, { id: 'desc' }],
    created_at: [{ created_at: order }, { id: order }],
  };

  return (
    map[sortBy] ?? [{ role: 'asc' }, { created_at: 'desc' }, { id: 'desc' }]
  );
}

function buildAdminCustomerOrderBy(sortBy, sortOrder) {
  const order = parseSortOrder(
    sortOrder,
    sortBy === 'created_at' || sortBy === 'updated_at' ? 'desc' : 'asc',
  );
  const map = {
    name: [{ name: order }, { id: 'desc' }],
    email: [{ user: { email: order } }, { id: 'desc' }],
    phone_number: [{ phone_number: order }, { id: 'desc' }],
    outlet: [
      { owner_location: { name: order } },
      { name: 'asc' },
      { id: 'desc' },
    ],
    points: [{ customer_point: { available_point: order } }, { id: 'desc' }],
    status: [{ status: order }, { id: 'desc' }],
    activation_status: [{ user: { activation_status: order } }, { id: 'desc' }],
    runchise_sync_status: [{ runchise_sync_status: order }, { id: 'desc' }],
    created_at: [
      { runchise_created_at: order },
      { runchise_id: order },
      { id: order },
    ],
    updated_at: [
      { runchise_updated_at: order },
      { runchise_id: order },
      { id: order },
    ],
  };

  return map[sortBy] ?? [{ runchise_created_at: 'desc' }, { id: 'desc' }];
}

function buildRedeemItemOrderBy(sortBy, sortOrder) {
  const order = parseSortOrder(
    sortOrder,
    sortBy === 'created_at' ? 'desc' : 'asc',
  );
  const map = {
    menu: [{ menu_item: { name: order } }, { id: 'asc' }],
    price: [{ menu_item: { price: order } }, { id: 'asc' }],
    points: [{ points_required: order }, { id: 'asc' }],
    status: [{ is_active: order }, { sort_order: 'asc' }, { id: 'asc' }],
    sort_order: [
      { category: { sort_order: order } },
      { sort_order: order },
      { id: 'asc' },
    ],
    created_at: [{ created_at: order }, { id: order }],
  };

  return (
    map[sortBy] ?? [
      { category: { sort_order: 'asc' } },
      { sort_order: 'asc' },
      { id: 'asc' },
    ]
  );
}

function normalizePhone(raw) {
  const phone = parseOptionalString(raw, 'phone_number', 30);
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function parseAdminUserRole(value) {
  const role = parseRequiredString(value ?? 'marketing', 'role', 30);

  if (!ADMIN_USER_ROLES.has(role)) {
    throw new ValidationError('role harus admin atau marketing');
  }

  return role;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${fieldName} harus berupa tanggal valid`);
  }

  return date;
}

function parseDateBoundary(value, fieldName, endOfDay = false) {
  const date = parseOptionalDate(value, fieldName);
  if (!date) return null;

  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }

  return date;
}

function parseOptionalNumber(value, fieldName, { min = 0 } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const number = Number(value);
  if (Number.isNaN(number) || number < min) {
    throw new ValidationError(`${fieldName} harus berupa angka minimal ${min}`);
  }

  return number;
}

function parseLocationIds(value, ownerLocationId = null) {
  const rawIds = Array.isArray(value) ? value : [];
  const ids = rawIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ownerLocationId) ids.push(ownerLocationId);

  return Array.from(new Set(ids));
}

function normalizeReportName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function getDefaultRedeemCategoryId(tx = prisma) {
  const category = await tx.redeemMenuCategory.findFirst({
    where: { is_active: true },
    orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    select: { id: true },
  });

  if (category) return category.id;

  const created = await tx.redeemMenuCategory.create({
    data: {
      name: 'Redeem Menu',
      sort_order: 0,
      is_active: true,
    },
    select: { id: true },
  });

  return created.id;
}

function parseCustomerStatus(value) {
  const status =
    parseOptionalString(value ?? 'active', 'status', 30) ?? 'active';
  const allowed = new Set(['active', 'inactive']);

  if (!allowed.has(status)) {
    throw new ValidationError('status harus active atau inactive');
  }

  return status;
}

function parseCustomerGender(value) {
  const gender =
    parseOptionalString(value ?? 'unknown', 'gender', 30) ?? 'unknown';
  const allowed = new Set(['male', 'female', 'unknown']);

  if (!allowed.has(gender)) {
    throw new ValidationError('gender harus male, female, atau unknown');
  }

  return gender;
}

function handleError(res, error) {
  if (error instanceof ValidationError) {
    return badRequest(res, error.message);
  }

  if (error.code === 'P2002') {
    return res.status(409).json({ message: 'Data duplikat' });
  }

  if (error.code === 'P2003') {
    return badRequest(res, 'Referensi data tidak valid');
  }

  if (error.code === 'P2025') {
    return res.status(404).json({ message: 'Data tidak ditemukan' });
  }

  return respondWithServerError(res, error, 'adminLoyaltyController');
}

async function listAdminUsers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const sortBy = parseOptionalString(req.query.sort_by, 'sort_by', 50);
    const sortOrder = parseOptionalString(
      req.query.sort_order,
      'sort_order',
      10,
    );
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);
    const where = {
      role: { in: ['admin', 'marketing'] },
      ...(search && {
        OR: [
          { email: { contains: search, mode: 'insensitive' } },
          { phone_number: { contains: search } },
          { role: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
    const total = await prisma.user.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: buildAdminUserOrderBy(sortBy, sortOrder),
      skip: (clampedPage - 1) * limit,
      take: limit,
    });

    res.json({ items: users, page: clampedPage, limit, total, total_pages: totalPages });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminActivityLogs(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const action = parseOptionalString(req.query.action, 'action', 80);
    const entityType = parseOptionalString(
      req.query.entity_type,
      'entity_type',
      80,
    );
    const actorId = parsePositiveInt(req.query.actor_user_id, 'actor_user_id', {
      required: false,
    });
    const from = parseDateBoundary(req.query.from, 'from');
    const to = parseDateBoundary(req.query.to, 'to', true);
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 50, 'limit'),
      100,
    );
    const where = {
      ...(action ? { action } : {}),
      ...(entityType ? { entity_type: entityType } : {}),
      ...(actorId ? { actor_user_id: actorId } : {}),
      ...(from || to
        ? {
            created_at: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { action: { contains: search, mode: 'insensitive' } },
              { entity_type: { contains: search, mode: 'insensitive' } },
              { actor_role: { contains: search, mode: 'insensitive' } },
              { actor: { email: { contains: search, mode: 'insensitive' } } },
              { actor: { phone_number: { contains: search } } },
            ],
          }
        : {}),
    };

    const total = await prisma.adminActivityLog.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const logs = await prisma.adminActivityLog.findMany({
      where,
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            phone_number: true,
            role: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      skip: (clampedPage - 1) * limit,
      take: limit,
    });

    res.json({
      items: logs,
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminUser(req, res) {
  try {
    const email = parseOptionalEmail(req.body.email);
    const phone_number = normalizePhone(req.body.phone_number);
    const password = parseRequiredString(req.body.password, 'password', 255);
    const role = parseAdminUserRole(req.body.role);

    if (!email && !phone_number) {
      return badRequest(res, 'Email atau nomor telepon wajib diisi');
    }

    if (password.length < 6) {
      return badRequest(res, 'Password minimal 6 karakter');
    }

    const password_hash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        phone_number,
        password_hash,
        role,
      },
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
    });

    await recordAdminActivity({
      req,
      action: 'create_admin_user',
      entityType: 'user',
      entityId: user.id,
      after: user,
      metadata: { role },
    });

    res.status(201).json(user);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminUser(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const unexpectedFields = Object.keys(req.body).filter(
      (field) => !ADMIN_USER_UPDATE_FIELDS.has(field),
    );
    if (unexpectedFields.length > 0) {
      return badRequest(
        res,
        `Field tidak diizinkan: ${unexpectedFields.join(', ')}`,
      );
    }

    // Guard target dijalankan sebelum parsing password/bcrypt dan sebelum
    // mutasi apa pun. Endpoint staff tidak boleh menjadi jalur modifikasi atau
    // promosi akun customer walaupun caller mengetahui ID user tersebut.
    const before = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
        customer: { select: { id: true } },
      },
    });

    if (!before) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    if (!ADMIN_USER_ROLES.has(before.role) || before.customer) {
      return badRequest(
        res,
        'Hanya akun staff admin atau marketing yang dapat diubah dari menu ini',
      );
    }

    const data = {};

    if (req.body.email !== undefined)
      data.email = parseOptionalEmail(req.body.email);
    if (req.body.phone_number !== undefined)
      data.phone_number = normalizePhone(req.body.phone_number);
    if (req.body.role !== undefined)
      data.role = parseAdminUserRole(req.body.role);

    if (req.body.password !== undefined && req.body.password !== '') {
      const password = parseRequiredString(req.body.password, 'password', 255);
      if (password.length < 6) {
        return badRequest(res, 'Password minimal 6 karakter');
      }
      data.password_hash = await bcrypt.hash(password, 10);
    }

    if (Object.keys(data).length === 0) {
      return badRequest(res, 'Tidak ada data yang diubah');
    }

    if (data.role && id === req.user.id && data.role !== 'admin') {
      return badRequest(res, 'Admin tidak dapat mengubah role akun sendiri');
    }

    const mustRevokeSessions =
      data.password_hash !== undefined ||
      (data.role !== undefined && data.role !== before.role);
    const transactionResult = await prisma.$transaction(async (tx) => {
      // Guard diulang dalam WHERE mutasi untuk mencegah race antara pembacaan
      // `before` dan update. updateMany memberi count tanpa melempar P2025.
      const updateResult = await tx.user.updateMany({
        where: {
          id,
          role: { in: [...ADMIN_USER_ROLES] },
          customer: { is: null },
        },
        data,
      });

      if (updateResult.count !== 1) return { conflict: true, user: null };

      if (mustRevokeSessions) {
        await tx.session.deleteMany({ where: { user_id: id } });
      }

      const user = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          phone_number: true,
          role: true,
          created_at: true,
          updated_at: true,
        },
      });

      return { conflict: false, user };
    });
    const user = transactionResult.user;

    if (transactionResult.conflict || !user) {
      return res.status(409).json({
        message:
          'Target berubah saat diproses; silakan muat ulang dan coba lagi',
      });
    }

    await recordAdminActivity({
      req,
      action: 'update_admin_user',
      entityType: 'user',
      entityId: user.id,
      before: {
        id: before.id,
        email: before.email,
        phone_number: before.phone_number,
        role: before.role,
        created_at: before.created_at,
        updated_at: before.updated_at,
      },
      after: user,
      metadata: {
        changed_fields: Object.keys(data),
        sessions_revoked: mustRevokeSessions,
      },
    });

    res.json(user);
  } catch (error) {
    handleError(res, error);
  }
}

async function deleteAdminUser(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');

    if (id === req.user.id) {
      return badRequest(res, 'Admin tidak dapat menghapus akun sendiri');
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { customer: { select: { id: true } } },
    });

    if (!user) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    if (user.customer) {
      return badRequest(
        res,
        'User customer tidak dapat dihapus dari menu admin ini',
      );
    }

    await prisma.$transaction([
      prisma.session.deleteMany({ where: { user_id: id } }),
      prisma.user.delete({ where: { id } }),
    ]);

    await recordAdminActivity({
      req,
      action: 'delete_admin_user',
      entityType: 'user',
      entityId: id,
      before: user,
    });

    res.json({ message: 'User berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

// Dashboard membaca tabel canonical Customer. Importer selektif sengaja tidak
// menyimpan ulang payload ke tabel staging agar penggunaan disk tetap kecil.
// Pagination, filter, dan sorting tetap dikerjakan PostgreSQL; Prisma hanya
// memuat maksimal satu halaman beserta relasi yang diperlukan UI.
async function listAdminCustomers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const sortBy = parseOptionalString(req.query.sort_by, 'sort_by', 50);
    const sortOrder = parseOptionalString(
      req.query.sort_order,
      'sort_order',
      10,
    );
    const from = parseDateBoundary(req.query.from, 'from');
    const to = parseDateBoundary(req.query.to, 'to', true);
    if (from && to && from > to) {
      return badRequest(res, 'from tidak boleh melebihi to');
    }

    // Tautan aktivasi akun hanya bisa dikirim lewat email, sehingga customer
    // tanpa email tidak akan pernah bisa mengaktifkan akunnya. Filter ini
    // dipakai petugas outlet untuk memunculkan daftar siapa saja yang emailnya
    // masih perlu dikumpulkan.
    const emailStatus =
      parseOptionalString(req.query.email_status, 'email_status', 20) ?? 'all';
    if (!['all', 'missing', 'present'].includes(emailStatus)) {
      return badRequest(
        res,
        'email_status hanya boleh all, missing, atau present',
      );
    }

    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 20, 'limit'),
      100,
    );
    const filters = [];
    // String kosong diperlakukan sama dengan NULL: keduanya berarti tidak ada
    // alamat yang bisa dikirimi tautan aktivasi.
    if (emailStatus === 'missing') {
      filters.push(
        Prisma.sql`(customer_user."email" IS NULL OR customer_user."email" = '')`,
      );
    } else if (emailStatus === 'present') {
      filters.push(
        Prisma.sql`(customer_user."email" IS NOT NULL AND customer_user."email" <> '')`,
      );
    }
    if (search) {
      const pattern = `%${search}%`;
      filters.push(Prisma.sql`(
        customer."name" ILIKE ${pattern}
        OR customer."phone_number" ILIKE ${pattern}
        OR customer_user."email" ILIKE ${pattern}
        OR customer."runchise_id"::text ILIKE ${pattern}
        OR EXISTS (
          SELECT 1
          FROM "CustomerLocation" search_customer_location
          JOIN "Location" search_location
            ON search_location."id" = search_customer_location."location_id"
          WHERE search_customer_location."customer_id" = customer."id"
            AND search_location."name" ILIKE ${pattern}
        )
      )`);
    }
    if (from) {
      filters.push(
        Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at") >= ${from}`,
      );
    }
    if (to) {
      filters.push(
        Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at") <= ${to}`,
      );
    }
    const filterSql = filters.length
      ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
      : Prisma.empty;

    const [countRow] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total,
        MIN(COALESCE(customer."runchise_created_at", customer."created_at")) AS earliest,
        MAX(COALESCE(customer."runchise_created_at", customer."created_at")) AS latest
      FROM "Customer" customer
      JOIN "User" customer_user ON customer_user."id" = customer."user_id"
      ${filterSql}
    `;
    const total = countRow?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const skip = (clampedPage - 1) * limit;
    const order = parseSortOrder(
      sortOrder,
      sortBy === 'created_at' || sortBy === 'updated_at' ? 'desc' : 'asc',
    );
    const direction = order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const orderColumns = {
      name: Prisma.sql`customer."name"`,
      email: Prisma.sql`customer_user."email"`,
      phone_number: Prisma.sql`customer."phone_number"`,
      outlet: Prisma.sql`(
        SELECT MIN(sort_location."name")
        FROM "CustomerLocation" sort_customer_location
        JOIN "Location" sort_location
          ON sort_location."id" = sort_customer_location."location_id"
        WHERE sort_customer_location."customer_id" = customer."id"
      )`,
      points: Prisma.sql`COALESCE(customer_point."available_point", 0)`,
      status: Prisma.sql`customer."status"`,
      activation_status: Prisma.sql`customer_user."activation_status"`,
      runchise_sync_status: Prisma.sql`customer."runchise_sync_status"`,
      created_at: Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at")`,
      updated_at: Prisma.sql`COALESCE(customer."runchise_updated_at", customer."updated_at")`,
    };
    const orderColumn =
      orderColumns[sortBy] ??
      Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at")`;

    const pageRows = await prisma.$queryRaw`
      SELECT customer."id"
      FROM "Customer" customer
      JOIN "User" customer_user ON customer_user."id" = customer."user_id"
      LEFT JOIN "CustomerPoint" customer_point
        ON customer_point."customer_id" = customer."id"
      ${filterSql}
      ORDER BY ${orderColumn} ${direction} NULLS LAST,
        customer."id" ${direction}
      OFFSET ${skip}
      LIMIT ${limit}
    `;
    const customerIds = pageRows.map((row) => row.id);
    const customers = customerIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: customerIds } },
          include: getAdminCustomerInclude(),
        })
      : [];
    const customerById = new Map(
      customers.map((customer) => [customer.id, customer]),
    );

    const items = customerIds.map((customerId) => {
      const customer = customerById.get(customerId);
      const customerLocations = [...(customer?.customer_locations ?? [])].sort(
        (a, b) => a.location_id - b.location_id,
      );
      const hasRunchiseDate = Boolean(customer?.runchise_created_at);

      return {
        ...customer,
        location_ids: customerLocations.map((row) => row.location_id),
        customer_locations: customerLocations,
        customer_point: customer?.customer_point ?? {
          total_point: 0,
          available_point: 0,
          next_reward_threshold: DEFAULT_REWARD_THRESHOLD,
        },
        created_at:
          customer?.runchise_created_at ?? customer?.created_at ?? null,
        updated_at:
          customer?.runchise_updated_at ?? customer?.updated_at ?? null,
        date_source: hasRunchiseDate ? 'runchise_sync' : 'local',
      };
    });

    res.json({
      items,
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
      registration_range: {
        earliest: countRow?.earliest ?? null,
        latest: countRow?.latest ?? null,
        source: 'canonical_customer',
      },
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminCustomer(req, res) {
  try {
    const name = parseRequiredString(req.body.name, 'name', 120);
    const phone_number = normalizePhone(req.body.phone_number);
    const email = parseOptionalEmail(req.body.email);
    const brand_id = parsePositiveInt(req.body.brand_id ?? 1, 'brand_id');
    const owner_location_id = parsePositiveInt(
      req.body.owner_location_id,
      'owner_location_id',
    );
    // H-1: Saldo poin tidak dapat diubah melalui endpoint ini dan hanya dikelola melalui mekanisme khusus yang tervalidasi serta tercatat untuk menjaga integritas data.
    const locationIds = parseLocationIds(
      req.body.location_ids,
      owner_location_id,
    );

    if (!phone_number) {
      return badRequest(res, 'Nomor telepon wajib diisi');
    }

    const customer = await prisma.$transaction(async (tx) => {
      await tx.brand.upsert({
        where: { id: brand_id },
        update: {},
        create: { id: brand_id, name: `Brand ${brand_id}` },
      });

      const user = await tx.user.create({
        data: {
          email,
          phone_number,
          password_hash: '',
          activation_status: 'pending_activation',
          activated_at: null,
          role: 'customer',
        },
      });

      return tx.customer.create({
        data: {
          user_id: user.id,
          name,
          phone_number,
          phone_number_country_code: parsePositiveInt(
            req.body.phone_number_country_code ?? 62,
            'phone_number_country_code',
          ),
          address: parseOptionalString(req.body.address, 'address', 1000),
          province: parseOptionalString(req.body.province, 'province', 120),
          city: parseOptionalString(req.body.city, 'city', 120),
          country: parseOptionalString(
            req.body.country ?? 'Indonesia',
            'country',
            120,
          ),
          postal_code: parseOptionalString(
            req.body.postal_code,
            'postal_code',
            20,
          ),
          dob: parseOptionalDate(req.body.dob, 'dob'),
          gender: parseCustomerGender(req.body.gender),
          status: parseCustomerStatus(req.body.status),
          balance: 0,
          brand_id,
          owner_location_id,
          created_by_id: req.user.id,
          last_updated_by_id: req.user.id,
          customer_point: {
            create: {
              total_point: 0,
              available_point: 0,
              next_reward_threshold: getDefaultRewardThreshold(),
            },
          },
          customer_locations:
            locationIds.length > 0
              ? {
                  create: locationIds.map((location_id) => ({ location_id })),
                }
              : undefined,
        },
        include: getAdminCustomerInclude(),
      });
    });

    const runchiseSync = await syncCustomerToRunchise(customer.id);

    let activationEmail = null;
    if (runchiseSync.status === 'synced') {
      try {
        activationEmail = await sendCustomerActivationLink(customer);
      } catch (emailError) {
        activationEmail = {
          sent: false,
          skipped: false,
          error: emailError.message,
        };
      }
    } else {
      activationEmail = {
        sent: false,
        skipped: true,
        reason: 'runchise_sync_not_synced',
        error:
          runchiseSync.error ||
          runchiseSync.reason ||
          'Customer belum tersinkron ke Runchise',
      };
    }

    const syncedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: getAdminCustomerInclude(),
    });

    await recordAdminActivity({
      req,
      action: 'create_customer',
      entityType: 'customer',
      entityId: syncedCustomer.id,
      after: syncedCustomer,
      metadata: {
        runchise_sync: runchiseSync,
        activation_email: activationEmail,
      },
    });

    res.status(201).json({
      ...syncedCustomer,
      runchise_sync: runchiseSync,
      activation_email: activationEmail,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function listCustomerSalesTransactionReports(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const outlet = parseOptionalString(req.query.outlet, 'outlet', 120);
    const from = parseDateBoundary(req.query.from, 'from');
    const to = parseDateBoundary(req.query.to, 'to', true);
    if (from && to && from > to) {
      return badRequest(res, 'from tidak boleh melebihi to');
    }
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 20, 'limit'),
      100,
    );
    const where = {
      AND: [
        {
          OR: [
            { penambahan_poin: { not: 0 } },
            { penggunaan_poin: { not: 0 } },
          ],
        },
        ...(search
          ? [
              {
                OR: [
                  {
                    nama_pelanggan: {
                      contains: search,
                      mode: 'insensitive',
                    },
                  },
                  { no_telepon: { contains: search } },
                  {
                    nama_outlet: { contains: search, mode: 'insensitive' },
                  },
                  {
                    tipe_order: { contains: search, mode: 'insensitive' },
                  },
                ],
              },
            ]
          : []),
      ],
      ...(outlet
        ? { nama_outlet: { equals: outlet, mode: 'insensitive' } }
        : {}),
      ...(from || to
        ? {
            tanggal_transaksi: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const total = await prisma.customerSalesTransactionReport.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const reports = await prisma.customerSalesTransactionReport.findMany({
      where,
      orderBy: [{ tanggal_transaksi: 'desc' }, { id: 'desc' }],
      skip: (clampedPage - 1) * limit,
      take: limit,
    });
    const reportTransactionIds = reports.map(
      (report) => report.runchise_sales_transaction_id,
    );
    const rewardRedemptions = reportTransactionIds.length
      ? await prisma.runchisePosRewardRedemption.findMany({
          where: {
            sale_transaction_id: { in: reportTransactionIds },
            status: 'valid',
          },
          select: {
            id: true,
            sale_transaction_id: true,
            runchise_product_id: true,
            redeem_menu_item_id: true,
            product_name: true,
            quantity: true,
            point_per_item: true,
            points_spent: true,
            is_managed_reward: true,
          },
          orderBy: [{ sale_transaction_id: 'asc' }, { id: 'asc' }],
        })
      : [];
    const rewardsByTransactionId = new Map();
    for (const reward of rewardRedemptions) {
      const items =
        rewardsByTransactionId.get(reward.sale_transaction_id) ?? [];
      items.push({
        id: reward.id.toString(),
        runchise_product_id: reward.runchise_product_id,
        redeem_menu_item_id: reward.redeem_menu_item_id,
        product_name: reward.product_name,
        quantity: Number(reward.quantity),
        point_per_item: reward.point_per_item,
        points_spent: reward.points_spent,
        is_managed_reward: reward.is_managed_reward,
      });
      rewardsByTransactionId.set(reward.sale_transaction_id, items);
    }
    res.json({
      items: reports.map((report) => ({
        ...report,
        redeemed_rewards:
          rewardsByTransactionId.get(report.runchise_sales_transaction_id) ??
          [],
        import_run_id:
          report.import_run_id === null || report.import_run_id === undefined
            ? null
            : report.import_run_id.toString(),
      })),
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
    });
  } catch (error) {
    handleError(res, error);
  }
}

// M-8: Daftar outlet dipisahkan ke endpoint khusus agar dimuat sekali saja dan tidak menghitung ulang tabel transaksi pada setiap permintaan.
async function listCustomerSalesTransactionReportOutlets(req, res) {
  try {
    const outletRows = await prisma.customerSalesTransactionReport.findMany({
      where: { nama_outlet: { not: null } },
      distinct: ['nama_outlet'],
      select: { nama_outlet: true },
      orderBy: { nama_outlet: 'asc' },
    });

    res.json(outletRows.map((row) => row.nama_outlet).filter(Boolean));
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const beforeCustomer = await getCustomerAuditSnapshot(id);
    const data = {};
    const userData = {};

    if (req.body.name !== undefined)
      data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.phone_number !== undefined) {
      data.phone_number = normalizePhone(req.body.phone_number);
      userData.phone_number = data.phone_number;
    }
    if (req.body.email !== undefined)
      userData.email = parseOptionalEmail(req.body.email);
    if (req.body.phone_number_country_code !== undefined) {
      data.phone_number_country_code = parsePositiveInt(
        req.body.phone_number_country_code,
        'phone_number_country_code',
      );
    }
    if (req.body.address !== undefined)
      data.address = parseOptionalString(req.body.address, 'address', 1000);
    if (req.body.province !== undefined)
      data.province = parseOptionalString(req.body.province, 'province', 120);
    if (req.body.city !== undefined)
      data.city = parseOptionalString(req.body.city, 'city', 120);
    if (req.body.country !== undefined)
      data.country = parseOptionalString(req.body.country, 'country', 120);
    if (req.body.postal_code !== undefined)
      data.postal_code = parseOptionalString(
        req.body.postal_code,
        'postal_code',
        20,
      );
    if (req.body.dob !== undefined)
      data.dob = parseOptionalDate(req.body.dob, 'dob');
    if (req.body.gender !== undefined)
      data.gender = parseCustomerGender(req.body.gender);
    if (req.body.status !== undefined)
      data.status = parseCustomerStatus(req.body.status);
    // H-1: Field saldo poin diabaikan pada endpoint ini agar perubahan hanya dapat dilakukan melalui mekanisme khusus yang tervalidasi dan tercatat, tanpa mengganggu pembaruan profil biasa.
    const blockedLoyaltyMutationAttempt = {};
    if (
      req.body.balance !== undefined &&
      Number(req.body.balance) !== Number(beforeCustomer?.balance ?? 0)
    ) {
      blockedLoyaltyMutationAttempt.balance = {
        attempted: req.body.balance,
        kept: beforeCustomer?.balance ?? 0,
      };
    }
    if (
      req.body.total_point !== undefined &&
      Number(req.body.total_point) !==
        Number(beforeCustomer?.customer_point?.total_point ?? 0)
    ) {
      blockedLoyaltyMutationAttempt.total_point = {
        attempted: req.body.total_point,
        kept: beforeCustomer?.customer_point?.total_point ?? 0,
      };
    }
    if (
      req.body.available_point !== undefined &&
      Number(req.body.available_point) !==
        Number(beforeCustomer?.customer_point?.available_point ?? 0)
    ) {
      blockedLoyaltyMutationAttempt.available_point = {
        attempted: req.body.available_point,
        kept: beforeCustomer?.customer_point?.available_point ?? 0,
      };
    }
    if (req.body.brand_id !== undefined)
      data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.owner_location_id !== undefined) {
      data.owner_location_id = parsePositiveInt(
        req.body.owner_location_id,
        'owner_location_id',
      );
    }
    data.last_updated_by_id = req.user.id;

    let shouldSendActivationEmail = false;

    const customer = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({
        where: { id },
        select: {
          user_id: true,
          owner_location_id: true,
          user: {
            select: {
              email: true,
              activation_status: true,
            },
          },
        },
      });

      if (!existing) {
        throw Object.assign(new Error('Customer tidak ditemukan'), {
          code: 'P2025',
        });
      }

      const effectiveOwnerLocationId =
        data.owner_location_id !== undefined
          ? data.owner_location_id
          : existing.owner_location_id;

      if (!effectiveOwnerLocationId) {
      throw new ValidationError('owner_location_id wajib diisi');
      }

      if (Object.keys(userData).length > 0) {
        await tx.user.update({
          where: { id: existing.user_id },
          data: userData,
        });

        if (
          Object.prototype.hasOwnProperty.call(userData, 'email') &&
          userData.email &&
          userData.email !== existing.user?.email &&
          existing.user?.activation_status === 'pending_activation'
        ) {
          shouldSendActivationEmail = true;
        }
      }

      if (
        req.body.location_ids !== undefined ||
        data.owner_location_id !== undefined
      ) {
        const ownerLocationId =
          data.owner_location_id !== undefined
            ? data.owner_location_id
            : existing.owner_location_id;
        const locationIds = parseLocationIds(
          req.body.location_ids,
          ownerLocationId,
        );

        await tx.customerLocation.deleteMany({ where: { customer_id: id } });

        if (locationIds.length > 0) {
          await tx.customerLocation.createMany({
            data: locationIds.map((location_id) => ({
              customer_id: id,
              location_id,
            })),
            skipDuplicates: true,
          });
        }
      }

      return tx.customer.update({
        where: { id },
        data,
        include: getAdminCustomerInclude(),
      });
    });

    const changedFields = getActualCustomerChangedFields({
      before: beforeCustomer,
      after: customer,
      customerFields: Object.keys(data),
      userFields: Object.keys(userData),
      locationIdsTouched: req.body.location_ids !== undefined,
    });

    if (Object.keys(blockedLoyaltyMutationAttempt).length > 0) {
      console.warn(
        `[admin-loyalty] blocked point/balance mutation attempt via profile update: customer_id=${id}, actor_user_id=${req.user.id}, actor_role=${req.user.role}`,
        blockedLoyaltyMutationAttempt,
      );
    }

    const runchiseSync = await syncCustomerToRunchise(customer.id);
    const syncedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: getAdminCustomerInclude(),
    });

    let activationEmail = null;
    if (shouldSendActivationEmail) {
      try {
        activationEmail = await sendCustomerActivationLink(syncedCustomer);
      } catch (emailError) {
        activationEmail = {
          sent: false,
          skipped: false,
          error: emailError.message,
        };
      }
    }

    await recordAdminActivity({
      req,
      action: 'update_customer',
      entityType: 'customer',
      entityId: syncedCustomer.id,
      before: beforeCustomer,
      after: syncedCustomer,
      metadata: {
        changed_fields: changedFields,
        runchise_sync: runchiseSync,
        activation_email: activationEmail,
        ...(Object.keys(blockedLoyaltyMutationAttempt).length > 0 && {
          blocked_loyalty_mutation_attempt: blockedLoyaltyMutationAttempt,
        }),
      },
    });

    res.json({
      ...syncedCustomer,
      runchise_sync: runchiseSync,
      activation_email: activationEmail,
    });
  } catch (error) {
    handleError(res, error);
  }
}

// H-1: Perubahan saldo poin hanya dapat dilakukan melalui endpoint khusus admin yang tervalidasi, mewajibkan alasan, menjaga konsistensi data, dan mencatat seluruh riwayat perubahan.

// M-6: Menggunakan locking dalam transaksi agar penyesuaian saldo poin tetap konsisten dan terhindar dari race condition pada permintaan bersamaan.
async function adjustCustomerLoyalty(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const reason = parseRequiredString(req.body.reason, 'reason', 500);

    const hasTotalPoint = req.body.total_point !== undefined;
    const hasAvailablePoint = req.body.available_point !== undefined;
    const hasBalance = req.body.balance !== undefined;

    if (!hasTotalPoint && !hasAvailablePoint && !hasBalance) {
      return badRequest(
        res,
        'Isi minimal salah satu dari total_point, available_point, atau balance',
      );
    }

    const nextTotalPoint = hasTotalPoint
      ? parseNonNegativeInt(req.body.total_point, 'total_point')
      : undefined;
    const nextAvailablePoint = hasAvailablePoint
      ? parseNonNegativeInt(req.body.available_point, 'available_point')
      : undefined;
    const nextBalance = hasBalance
      ? (parseOptionalNumber(req.body.balance, 'balance') ?? 0)
      : undefined;

    // Snapshot ini hanya digunakan untuk audit log, sedangkan validasi dilakukan ulang di dalam transaksi menggunakan data terbaru yang telah dikunci.
    const beforeCustomer = await getCustomerAuditSnapshot(id);
    if (!beforeCustomer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    const { customer, currentTotalPoint, currentAvailablePoint } =
      await prisma.$transaction(async (tx) => {
        // Mengunci baris Customer selama transaksi untuk memastikan data masih valid dan mencegah perubahan bersamaan.
        const [customerRow] = await tx.$queryRaw`
          SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE
        `;
        if (!customerRow) {
          throw Object.assign(new Error('Customer tidak ditemukan'), {
            code: 'P2025',
          });
        }

        let lockedTotalPoint = 0;
        let lockedAvailablePoint = 0;

        if (hasTotalPoint || hasAvailablePoint) {
          // M-6: Mengunci baris selama transaksi agar permintaan bersamaan selalu menggunakan data terbaru dan mencegah race condition.
          const [pointRow] = await tx.$queryRaw`
            SELECT total_point, available_point FROM "CustomerPoint"
            WHERE customer_id = ${id} FOR UPDATE
          `;
          lockedTotalPoint = pointRow?.total_point ?? 0;
          lockedAvailablePoint = pointRow?.available_point ?? 0;

          const effectiveTotalPoint = nextTotalPoint ?? lockedTotalPoint;
          const effectiveAvailablePoint =
            nextAvailablePoint ?? lockedAvailablePoint;

          if (effectiveAvailablePoint > effectiveTotalPoint) {
            throw Object.assign(
              new Error('available_point tidak boleh melebihi total_point'),
              { code: 'INVALID_INVARIANT' },
            );
          }

          await tx.customerPoint.upsert({
            where: { customer_id: id },
            update: {
              ...(hasTotalPoint && { total_point: nextTotalPoint }),
              ...(hasAvailablePoint && {
                available_point: nextAvailablePoint,
              }),
            },
            create: {
              customer_id: id,
              total_point: effectiveTotalPoint,
              available_point: effectiveAvailablePoint,
              next_reward_threshold: getDefaultRewardThreshold(),
            },
          });

          // Mencatat setiap penyesuaian poin sebagai transaksi terpisah agar riwayat koreksi manual tetap terlacak dan dapat dibedakan dari transaksi POS.
          const pointsChange = effectiveAvailablePoint - lockedAvailablePoint;
          if (pointsChange !== 0) {
            await tx.pointHistory.create({
              data: {
                customer_id: id,
                points_change: pointsChange,
                type: 'admin_adjustment',
                description: reason,
              },
            });
          }
        }

        if (hasBalance) {
          await tx.customer.update({
            where: { id },
            data: { balance: nextBalance, last_updated_by_id: req.user.id },
          });
        }

        const updatedCustomer = await tx.customer.findUnique({
          where: { id },
          include: getAdminCustomerInclude(),
        });

        return {
          customer: updatedCustomer,
          currentTotalPoint: lockedTotalPoint,
          currentAvailablePoint: lockedAvailablePoint,
        };
      });

    await recordAdminActivity({
      req,
      action: 'adjust_customer_loyalty',
      entityType: 'customer',
      entityId: id,
      before: beforeCustomer,
      after: customer,
      metadata: {
        reason,
        changes: {
          ...(hasTotalPoint && {
            total_point: { before: currentTotalPoint, after: nextTotalPoint },
          }),
          ...(hasAvailablePoint && {
            available_point: {
              before: currentAvailablePoint,
              after: nextAvailablePoint,
            },
          }),
          ...(hasBalance && {
            balance: { before: beforeCustomer.balance, after: nextBalance },
          }),
        },
      },
    });

    res.json(customer);
  } catch (error) {
    if (error.code === 'INVALID_INVARIANT') {
      return badRequest(res, error.message);
    }
    handleError(res, error);
  }
}

async function resendCustomerActivation(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone_number: true,
            role: true,
            activation_status: true,
            activated_at: true,
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    if (customer.user.activation_status !== 'pending_activation') {
      return res.status(400).json({
        message: 'Akun customer sudah aktif atau tidak membutuhkan aktivasi',
      });
    }

    const activationEmail = await sendCustomerActivationLink(customer);

    await recordAdminActivity({
      req,
      action: 'resend_customer_activation',
      entityType: 'customer',
      entityId: customer.id,
      after: customer,
      metadata: { activation_email: activationEmail },
    });

    res.json({
      message: activationEmail.sent
        ? 'Email aktivasi berhasil dikirim'
        : 'Email aktivasi belum terkirim',
      activation_email: activationEmail,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function retryCustomerRunchiseSync(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const runchiseSync = await syncCustomerToRunchise(id, {
      allowCreate: false,
    });
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: getAdminCustomerInclude(),
    });

    await recordAdminActivity({
      req,
      action: 'retry_customer_runchise_sync',
      entityType: 'customer',
      entityId: id,
      after: customer,
      metadata: { runchise_sync: runchiseSync },
    });

    res.json({
      ...customer,
      runchise_sync: runchiseSync,
    });
  } catch (error) {
    handleError(res, error);
  }
}

// M-7: Memastikan seluruh relasi foreign key ditangani sesuai aturan database agar penghapusan customer tidak gagal akibat constraint yang belum dibersihkan.
async function deleteAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const beforeCustomer = await getCustomerAuditSnapshot(id);
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { user_id: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    await prisma.$transaction([
      prisma.pointHistory.deleteMany({ where: { customer_id: id } }),
      prisma.rewardRedemption.deleteMany({ where: { customer_id: id } }),
      prisma.customerPoint.deleteMany({ where: { customer_id: id } }),
      prisma.customerLocation.deleteMany({ where: { customer_id: id } }),
      prisma.customer.delete({ where: { id } }),
      prisma.session.deleteMany({ where: { user_id: customer.user_id } }),
      prisma.accountActivationToken.deleteMany({
        where: { user_id: customer.user_id },
      }),
      prisma.user.delete({ where: { id: customer.user_id } }),
    ]);

    await recordAdminActivity({
      req,
      action: 'delete_customer',
      entityType: 'customer',
      entityId: id,
      before: beforeCustomer,
    });

    res.json({ message: 'Customer berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminBrands(req, res) {
  try {
    const brands = await prisma.brand.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    res.json(brands);
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminLocations(req, res) {
  try {
    const locations = await prisma.location.findMany({
      where: { is_active: true, is_outlet: true },
      select: { id: true, name: true, city: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    res.json(locations);
  } catch (error) {
    handleError(res, error);
  }
}

const getSummary = createGetSummary({
  prisma,
  Prisma,
  parsePositiveInt,
  parseDateBoundary,
  toRedemptionTrend,
  toPublicRedemptionHistory,
  handleError,
});

async function listRewards(req, res) {
  try {
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);
    const total = await prisma.rewardsCatalog.count();
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const rewards = await prisma.rewardsCatalog.findMany({
      include: { brand: { select: { id: true, name: true } } },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
      skip: (clampedPage - 1) * limit,
      take: limit,
    });

    res.json({ items: rewards, page: clampedPage, limit, total, total_pages: totalPages });
  } catch (error) {
    handleError(res, error);
  }
}

async function createReward(req, res) {
  try {
    const reward = await prisma.rewardsCatalog.create({
      data: {
        brand_id: parsePositiveInt(req.body.brand_id ?? 1, 'brand_id'),
        name: parseRequiredString(req.body.name, 'name', 120),
        description: parseOptionalString(
          req.body.description,
          'description',
          1000,
        ),
        points_required: parsePositiveInt(
          req.body.points_required,
          'points_required',
        ),
        image_url: parseOptionalString(req.body.image_url, 'image_url', 1000),
        is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
      },
    });

    res.status(201).json(reward);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateReward(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.brand_id !== undefined)
      data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.name !== undefined)
      data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.description !== undefined)
      data.description = parseOptionalString(
        req.body.description,
        'description',
        1000,
      );
    if (req.body.points_required !== undefined)
      data.points_required = parsePositiveInt(
        req.body.points_required,
        'points_required',
      );
    if (req.body.image_url !== undefined)
      data.image_url = parseOptionalString(
        req.body.image_url,
        'image_url',
        1000,
      );
    if (req.body.is_active !== undefined)
      data.is_active = parseBoolean(req.body.is_active, 'is_active');

    const reward = await prisma.rewardsCatalog.update({ where: { id }, data });
    res.json(reward);
  } catch (error) {
    handleError(res, error);
  }
}

const {
  listCatalogMenuItems,
  listRedeemCategories,
  createRedeemCategory,
  updateRedeemCategory,
  listRedeemItems,
  createRedeemItem,
  updateRedeemItem,
  deleteRedeemItem,
  listRedemptions,
  updateRedemptionStatus,
} = createRedeemAdminControllers({
  prisma,
  Prisma,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
  getRedeemCatalogConfig,
  normalizeReportName,
  parseOptionalString,
  parseRequiredString,
  parsePositiveInt,
  parseBoolean,
  parseNonNegativeInt,
  parseOptionalDate,
  buildRedeemItemOrderBy,
  addRedeemPriceBreakdown,
  getDefaultRedeemCategoryId,
  recordAdminActivity,
  handleError,
  badRequest,
  getDefaultRewardThreshold,
  REDEEM_ITEM_SELECT,
  REDEEM_ITEM_AUDIT_INCLUDE,
});

module.exports = {
  listAdminUsers,
  listAdminActivityLogs,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  listAdminCustomers,
  listCustomerSalesTransactionReports,
  listCustomerSalesTransactionReportOutlets,
  createAdminCustomer,
  updateAdminCustomer,
  adjustCustomerLoyalty,
  resendCustomerActivation,
  retryCustomerRunchiseSync,
  deleteAdminCustomer,
  listAdminBrands,
  listAdminLocations,
  getSummary,
  listRewards,
  createReward,
  updateReward,
  listCatalogMenuItems,
  listRedeemCategories,
  createRedeemCategory,
  updateRedeemCategory,
  listRedeemItems,
  createRedeemItem,
  updateRedeemItem,
  deleteRedeemItem,
  listRedemptions,
  updateRedemptionStatus,
};
