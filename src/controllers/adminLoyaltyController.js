const prisma = require('../lib/prisma');
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

const DEFAULT_PB1_RATE = 0.1;
const DEFAULT_REWARD_THRESHOLD = 2000;
const DEFAULT_RUNCHISE_PARENT_BRAND_ID = 750;
const DEFAULT_RUNCHISE_REDEEM_SUB_BRAND_ID = 1041;

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

function badRequest(res, message) {
  return res.status(400).json({ message });
}

function parsePositiveInt(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new Error(`${fieldName} wajib diisi`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} harus berupa integer positif`);
  }

  return number;
}

function parseNonNegativeInt(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new Error(`${fieldName} wajib diisi`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} harus berupa integer non-negatif`);
  }

  return number;
}

function parseBoolean(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new Error(`${fieldName} wajib diisi`);
  }

  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(`${fieldName} harus berupa boolean`);
}

function parseOptionalString(value, fieldName, maxLength = 255) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new Error(`${fieldName} harus berupa string`);

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} maksimal ${maxLength} karakter`);
  }

  return trimmed || null;
}

function parseRequiredString(value, fieldName, maxLength = 255) {
  const parsed = parseOptionalString(value, fieldName, maxLength);
  if (!parsed) throw new Error(`${fieldName} wajib diisi`);
  return parsed;
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
  const allowedRoles = new Set(['admin', 'staff', 'marketing']);

  if (!allowedRoles.has(role)) {
    throw new Error('role harus admin, staff, atau marketing');
  }

  return role;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} harus berupa tanggal valid`);
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
    throw new Error(`${fieldName} harus berupa angka minimal ${min}`);
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
    throw new Error('status harus active atau inactive');
  }

  return status;
}

function parseCustomerGender(value) {
  const gender =
    parseOptionalString(value ?? 'unknown', 'gender', 30) ?? 'unknown';
  const allowed = new Set(['male', 'female', 'unknown']);

  if (!allowed.has(gender)) {
    throw new Error('gender harus male, female, atau unknown');
  }

  return gender;
}

function handleError(res, error) {
  if (error.message?.includes('harus') || error.message?.includes('wajib')) {
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

  return res.status(500).json({ error: error.message });
}

async function listAdminUsers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);

    const users = await prisma.user.findMany({
      where: {
        role: { in: ['admin', 'staff', 'marketing'] },
        ...(search && {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { phone_number: { contains: search } },
            { role: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: [{ role: 'asc' }, { created_at: 'desc' }],
    });

    res.json(users);
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminUser(req, res) {
  try {
    const email = parseOptionalString(req.body.email, 'email', 255);
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

    res.status(201).json(user);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminUser(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.email !== undefined)
      data.email = parseOptionalString(req.body.email, 'email', 255);
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

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
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

    res.json({ message: 'User berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminCustomers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 20, 'limit'),
      100,
    );
    const where = {
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone_number: { contains: search } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
          {
            owner_location: { name: { contains: search, mode: 'insensitive' } },
          },
        ],
      }),
    };

    const total = await prisma.customer.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const skip = (clampedPage - 1) * limit;

    const customers = await prisma.customer.findMany({
      where,
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
        brand: { select: { id: true, name: true } },
        owner_location: { select: { id: true, name: true, city: true } },
        customer_locations: {
          select: {
            location_id: true,
            location: { select: { id: true, name: true, city: true } },
          },
        },
        customer_point: true,
      },
      orderBy: { updated_at: 'desc' },
      skip,
      take: limit,
    });

    res.json({
      items: customers,
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminCustomer(req, res) {
  try {
    const name = parseRequiredString(req.body.name, 'name', 120);
    const phone_number = normalizePhone(req.body.phone_number);
    const email = parseOptionalString(req.body.email, 'email', 255);
    const brand_id = parsePositiveInt(req.body.brand_id ?? 1, 'brand_id');
    const owner_location_id = parsePositiveInt(
      req.body.owner_location_id,
      'owner_location_id',
    );
    const total_point = parseNonNegativeInt(
      req.body.total_point ?? 0,
      'total_point',
    );
    const available_point = parseNonNegativeInt(
      req.body.available_point ?? total_point,
      'available_point',
    );
    const locationIds = parseLocationIds(req.body.location_ids, owner_location_id);

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
          balance: parseOptionalNumber(req.body.balance ?? 0, 'balance') ?? 0,
          brand_id,
          owner_location_id,
          created_by_id: req.user.id,
          last_updated_by_id: req.user.id,
          customer_point: {
            create: {
              total_point,
              available_point,
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
    try {
      activationEmail = await sendCustomerActivationLink(customer);
    } catch (emailError) {
      activationEmail = {
        sent: false,
        skipped: false,
        error: emailError.message,
      };
    }

    const syncedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: getAdminCustomerInclude(),
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

async function updateAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};
    const userData = {};
    const pointData = {};

    if (req.body.name !== undefined)
      data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.phone_number !== undefined) {
      data.phone_number = normalizePhone(req.body.phone_number);
      userData.phone_number = data.phone_number;
    }
    if (req.body.email !== undefined)
      userData.email = parseOptionalString(req.body.email, 'email', 255);
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
    if (req.body.balance !== undefined)
      data.balance = parseOptionalNumber(req.body.balance, 'balance') ?? 0;
    if (req.body.brand_id !== undefined)
      data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.owner_location_id !== undefined) {
      data.owner_location_id = parsePositiveInt(
        req.body.owner_location_id,
        'owner_location_id',
      );
    }
    if (req.body.total_point !== undefined) {
      pointData.total_point = parseNonNegativeInt(
        req.body.total_point,
        'total_point',
      );
    }
    if (req.body.available_point !== undefined) {
      pointData.available_point = parseNonNegativeInt(
        req.body.available_point,
        'available_point',
      );
    }
    data.last_updated_by_id = req.user.id;

    const customer = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({
        where: { id },
        select: { user_id: true, owner_location_id: true },
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
        throw new Error('owner_location_id wajib diisi');
      }

      if (Object.keys(userData).length > 0) {
        await tx.user.update({
          where: { id: existing.user_id },
          data: userData,
        });
      }

    if (Object.keys(pointData).length > 0) {
        await tx.customerPoint.upsert({
          where: { customer_id: id },
          update: pointData,
          create: {
            customer_id: id,
            total_point: pointData.total_point ?? 0,
            available_point: pointData.available_point ?? 0,
            next_reward_threshold: getDefaultRewardThreshold(),
          },
        });
      }

      if (req.body.location_ids !== undefined || data.owner_location_id !== undefined) {
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

    const runchiseSync = await syncCustomerToRunchise(customer.id);
    const syncedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: getAdminCustomerInclude(),
    });

    res.json({
      ...syncedCustomer,
      runchise_sync: runchiseSync,
    });
  } catch (error) {
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
    const runchiseSync = await syncCustomerToRunchise(id);
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: getAdminCustomerInclude(),
    });

    res.json({
      ...customer,
      runchise_sync: runchiseSync,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function deleteAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
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
      prisma.user.delete({ where: { id: customer.user_id } }),
    ]);

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

async function getSummary(req, res) {
  try {
    const redemptionFrom = parseDateBoundary(
      req.query.redemption_from,
      'redemption_from',
    );
    const redemptionTo = parseDateBoundary(
      req.query.redemption_to,
      'redemption_to',
      true,
    );
    const outletId = parsePositiveInt(req.query.outlet_id, 'outlet_id', {
      required: false,
    });
    const redemptionDateWhere = {
      redeemed_at: {
        not: null,
        ...(redemptionFrom ? { gte: redemptionFrom } : {}),
        ...(redemptionTo ? { lte: redemptionTo } : {}),
      },
      ...(outletId
        ? { customer: { owner_location_id: outletId } }
        : {}),
    };
    const [
      totalMembers,
      activeMembers,
      points,
      pointsEarned,
      pointsRedeemed,
      redemptionCount,
      pendingRedemptions,
      claimedRedemptions,
      topRewards,
      activatedCustomersByOutlet,
      redemptionsByCustomer,
      redemptionHistory,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.customer.count({ where: { status: 'active' } }),
      prisma.customerPoint.aggregate({
        _sum: { total_point: true, available_point: true },
      }),
      prisma.pointHistory.aggregate({
        where: { points_change: { gt: 0 } },
        _sum: { points_change: true },
      }),
      prisma.pointHistory.aggregate({
        where: { points_change: { lt: 0 } },
        _sum: { points_change: true },
      }),
      prisma.rewardRedemption.count(),
      prisma.rewardRedemption.count({ where: { status: 'pending' } }),
      prisma.rewardRedemption.count({ where: { status: 'claimed' } }),
      prisma.rewardRedemption.groupBy({
        by: ['reward_id'],
        _count: { reward_id: true },
        _sum: { points_spent: true },
        orderBy: { _count: { reward_id: 'desc' } },
        take: 5,
      }),
      prisma.customer.groupBy({
        by: ['owner_location_id'],
        where: {
          owner_location_id: { not: null },
          user: { password_hash: { not: '' } },
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.rewardRedemption.groupBy({
        by: ['customer_id'],
        _count: { id: true },
        _sum: { points_spent: true },
      }),
      prisma.rewardRedemption.findMany({
        where: redemptionDateWhere,
        include: {
          reward: { select: { id: true, name: true, points_required: true } },
          customer: {
            select: {
              id: true,
              name: true,
              owner_location: { select: { id: true, name: true, city: true } },
            },
          },
        },
        orderBy: { redeemed_at: 'desc' },
      }),
    ]);

    const rewardIds = topRewards.map((item) => item.reward_id);
    const outletIds = activatedCustomersByOutlet
      .map((item) => item.owner_location_id)
      .filter(Boolean);
    const redemptionCustomerIds = redemptionsByCustomer.map(
      (item) => item.customer_id,
    );
    const [rewards, outlets, redemptionCustomers, redeemMenuItemsForReport] =
      await Promise.all([
        prisma.rewardsCatalog.findMany({
          where: { id: { in: rewardIds } },
          select: { id: true, name: true },
        }),
        prisma.location.findMany({
          where: { id: { in: outletIds } },
          select: { id: true, name: true, city: true },
        }),
        prisma.customer.findMany({
          where: { id: { in: redemptionCustomerIds } },
          select: {
            id: true,
            owner_location_id: true,
            owner_location: { select: { id: true, name: true, city: true } },
          },
        }),
        prisma.redeemMenuItem.findMany({
          select: { menu_item: { select: { name: true, price: true } } },
        }),
      ]);
    const rewardById = new Map(rewards.map((reward) => [reward.id, reward]));
    const outletById = new Map(outlets.map((outlet) => [outlet.id, outlet]));
    const customerById = new Map(
      redemptionCustomers.map((customer) => [customer.id, customer]),
    );
    const outletRedemptionById = new Map();
    const redemptionTrendByDate = new Map();
    const redeemMenuByName = new Map(
      redeemMenuItemsForReport.map((item) => [
        normalizeReportName(item.menu_item.name),
        {
          menu_price: Number(item.menu_item.price),
        },
      ]),
    );

    for (const redemption of redemptionsByCustomer) {
      const customer = customerById.get(redemption.customer_id);
      const outlet = customer?.owner_location;
      if (!outlet) continue;

      const current = outletRedemptionById.get(outlet.id) ?? {
        outlet_id: outlet.id,
        outlet_name: outlet.name,
        city: outlet.city,
        redemption_count: 0,
        points_spent: 0,
      };

      current.redemption_count += redemption._count.id;
      current.points_spent += redemption._sum.points_spent ?? 0;
      outletRedemptionById.set(outlet.id, current);
    }

    for (const redemption of redemptionHistory) {
      if (!redemption.redeemed_at) continue;

      const date = redemption.redeemed_at.toISOString().slice(0, 10);
      const current = redemptionTrendByDate.get(date) ?? {
        date,
        redemption_count: 0,
        points_spent: 0,
      };

      current.redemption_count += 1;
      current.points_spent += redemption.points_spent;
      redemptionTrendByDate.set(date, current);
    }

    res.json({
      total_members: totalMembers,
      active_members: activeMembers,
      total_points_given: points._sum.total_point ?? 0,
      total_points_available: points._sum.available_point ?? 0,
      points_earned: pointsEarned._sum.points_change ?? 0,
      points_redeemed: Math.abs(pointsRedeemed._sum.points_change ?? 0),
      redemption_count: redemptionCount,
      pending_redemptions: pendingRedemptions,
      claimed_redemptions: claimedRedemptions,
      top_rewards: topRewards.map((item) => ({
        reward_id: item.reward_id,
        reward_name: rewardById.get(item.reward_id)?.name ?? 'Reward',
        redemption_count: item._count.reward_id,
        points_spent: item._sum.points_spent ?? 0,
      })),
      activation_by_outlet: activatedCustomersByOutlet.map((item) => {
        const outlet = outletById.get(item.owner_location_id);

        return {
          outlet_id: item.owner_location_id,
          outlet_name: outlet?.name ?? 'Outlet tidak diketahui',
          city: outlet?.city ?? null,
          activated_count: item._count.id,
        };
      }),
      top_redeem_outlets: Array.from(outletRedemptionById.values())
        .sort((a, b) => b.redemption_count - a.redemption_count)
        .slice(0, 5),
      redemption_trend: Array.from(redemptionTrendByDate.values()).sort(
        (a, b) => a.date.localeCompare(b.date),
      ),
      redemption_history: redemptionHistory.map((redemption) => ({
        id: redemption.id,
        reward_id: redemption.reward_id,
        reward_name: redemption.reward.name,
        points_spent: redemption.points_spent,
        menu_price:
          redeemMenuByName.get(normalizeReportName(redemption.reward.name))
            ?.menu_price ?? null,
        outlet_id: redemption.customer.owner_location?.id ?? null,
        outlet_name:
          redemption.customer.owner_location?.name ?? 'Outlet tidak diketahui',
        outlet_city: redemption.customer.owner_location?.city ?? null,
        redeemed_at: redemption.redeemed_at,
      })),
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function listRewards(req, res) {
  try {
    const rewards = await prisma.rewardsCatalog.findMany({
      include: { brand: { select: { id: true, name: true } } },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
    });

    res.json(rewards);
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

async function listCatalogMenuItems(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 50, 'limit'),
      1000,
    );
    const { parentBrandRunchiseId, redeemSubBrandRunchiseId } =
      getRedeemCatalogConfig();
    const redeemSubBrand = await prisma.subBrand.findFirst({
      where: {
        runchise_id: redeemSubBrandRunchiseId,
        brand: { runchise_id: parentBrandRunchiseId },
      },
      select: { id: true },
    });

    if (!redeemSubBrand) {
      return res.json({ categories: [], items: [] });
    }

    const categoryWhere = {
      name: { notIn: Array.from(EXCLUDED_CRISBAR_CATEGORY_NAMES) },
      sub_brand_links: {
        some: {
          sub_brand_id: redeemSubBrand.id,
        },
      },
    };
    const itemWhere = {
      category: categoryWhere,
      ...(search && {
        name: { contains: search, mode: 'insensitive' },
      }),
    };

    const [categories, items] = await Promise.all([
      prisma.menuCategory.findMany({
        where: {
          ...categoryWhere,
          items: {
            some: search
              ? { name: { contains: search, mode: 'insensitive' } }
              : {},
          },
        },
        select: { id: true, name: true, is_active: true },
        orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
      }),
      prisma.menuItem.findMany({
        where: itemWhere,
        include: {
          category: { select: { id: true, name: true, is_active: true } },
        },
        orderBy: [
          { category: { is_active: 'desc' } },
          { category: { name: 'asc' } },
          { name: 'asc' },
        ],
        take: limit,
      }),
    ]);

    const itemCategoryIds = new Set(
      items.map((item) => item.category?.id).filter(Boolean),
    );
    const visibleCategories = categories.filter((category) =>
      itemCategoryIds.has(category.id),
    );

    res.json({ categories: visibleCategories, items });
  } catch (error) {
    handleError(res, error);
  }
}

async function listRedeemCategories(req, res) {
  try {
    const categories = await prisma.redeemMenuCategory.findMany({
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });
    res.json(categories);
  } catch (error) {
    handleError(res, error);
  }
}

async function createRedeemCategory(req, res) {
  try {
    const category = await prisma.redeemMenuCategory.create({
      data: {
        name: parseRequiredString(req.body.name, 'name', 80),
        sort_order: parseNonNegativeInt(req.body.sort_order ?? 0, 'sort_order'),
        is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
      },
    });
    res.status(201).json(category);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateRedeemCategory(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.name !== undefined)
      data.name = parseRequiredString(req.body.name, 'name', 80);
    if (req.body.sort_order !== undefined)
      data.sort_order = parseNonNegativeInt(req.body.sort_order, 'sort_order');
    if (req.body.is_active !== undefined)
      data.is_active = parseBoolean(req.body.is_active, 'is_active');

    const category = await prisma.redeemMenuCategory.update({
      where: { id },
      data,
    });
    res.json(category);
  } catch (error) {
    handleError(res, error);
  }
}

async function listRedeemItems(req, res) {
  try {
    const items = await prisma.redeemMenuItem.findMany({
      select: {
        id: true,
        menu_item_id: true,
        category_id: true,
        points_required: true,
        is_active: true,
        badge: true,
        sort_order: true,
        start_at: true,
        end_at: true,
        stock_limit: true,
        daily_limit: true,
        created_at: true,
        updated_at: true,
        category: {
          select: {
            id: true,
            name: true,
            sort_order: true,
            is_active: true,
            created_at: true,
            updated_at: true,
          },
        },
        menu_item: {
          include: { category: { select: { id: true, name: true } } },
        },
      },
      orderBy: [
        { category: { sort_order: 'asc' } },
        { sort_order: 'asc' },
        { id: 'asc' },
      ],
    });

    res.json(items.map(addRedeemPriceBreakdown));
  } catch (error) {
    handleError(res, error);
  }
}

async function createRedeemItem(req, res) {
  try {
    const categoryId =
      parsePositiveInt(req.body.category_id, 'category_id', {
        required: false,
      }) ?? (await getDefaultRedeemCategoryId());

    const item = await prisma.redeemMenuItem.create({
      data: {
        menu_item_id: parsePositiveInt(req.body.menu_item_id, 'menu_item_id'),
        category_id: categoryId,
        points_required: parsePositiveInt(
          req.body.points_required,
          'points_required',
        ),
        is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
        badge: parseOptionalString(req.body.badge, 'badge', 40),
        sort_order: parseNonNegativeInt(req.body.sort_order ?? 0, 'sort_order'),
        start_at: parseOptionalDate(req.body.start_at, 'start_at'),
        end_at: parseOptionalDate(req.body.end_at, 'end_at'),
        stock_limit: parsePositiveInt(req.body.stock_limit, 'stock_limit', {
          required: false,
        }),
        daily_limit: parsePositiveInt(req.body.daily_limit, 'daily_limit', {
          required: false,
        }),
      },
      select: {
        id: true,
        menu_item_id: true,
        category_id: true,
        points_required: true,
        is_active: true,
        badge: true,
        sort_order: true,
        start_at: true,
        end_at: true,
        stock_limit: true,
        daily_limit: true,
        created_at: true,
        updated_at: true,
        category: {
          select: {
            id: true,
            name: true,
            sort_order: true,
            is_active: true,
            created_at: true,
            updated_at: true,
          },
        },
        menu_item: {
          include: { category: { select: { id: true, name: true } } },
        },
      },
    });

    res.status(201).json(addRedeemPriceBreakdown(item));
  } catch (error) {
    handleError(res, error);
  }
}

async function updateRedeemItem(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.menu_item_id !== undefined)
      data.menu_item_id = parsePositiveInt(
        req.body.menu_item_id,
        'menu_item_id',
      );
    if (req.body.category_id !== undefined)
      data.category_id = parsePositiveInt(req.body.category_id, 'category_id');
    if (req.body.points_required !== undefined)
      data.points_required = parsePositiveInt(
        req.body.points_required,
        'points_required',
      );
    if (req.body.is_active !== undefined)
      data.is_active = parseBoolean(req.body.is_active, 'is_active');
    if (req.body.badge !== undefined)
      data.badge = parseOptionalString(req.body.badge, 'badge', 40);
    if (req.body.sort_order !== undefined)
      data.sort_order = parseNonNegativeInt(req.body.sort_order, 'sort_order');
    if (req.body.start_at !== undefined)
      data.start_at = parseOptionalDate(req.body.start_at, 'start_at');
    if (req.body.end_at !== undefined)
      data.end_at = parseOptionalDate(req.body.end_at, 'end_at');
    if (req.body.stock_limit !== undefined)
      data.stock_limit = parsePositiveInt(req.body.stock_limit, 'stock_limit', {
        required: false,
      });
    if (req.body.daily_limit !== undefined)
      data.daily_limit = parsePositiveInt(req.body.daily_limit, 'daily_limit', {
        required: false,
      });

    const item = await prisma.redeemMenuItem.update({
      where: { id },
      data,
      select: {
        id: true,
        menu_item_id: true,
        category_id: true,
        points_required: true,
        is_active: true,
        badge: true,
        sort_order: true,
        start_at: true,
        end_at: true,
        stock_limit: true,
        daily_limit: true,
        created_at: true,
        updated_at: true,
        category: {
          select: {
            id: true,
            name: true,
            sort_order: true,
            is_active: true,
            created_at: true,
            updated_at: true,
          },
        },
        menu_item: {
          include: { category: { select: { id: true, name: true } } },
        },
      },
    });

    res.json(addRedeemPriceBreakdown(item));
  } catch (error) {
    handleError(res, error);
  }
}

async function deleteRedeemItem(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');

    await prisma.redeemMenuItem.delete({ where: { id } });

    res.json({ message: 'Item redeem berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

async function listRedemptions(req, res) {
  try {
    const status = parseOptionalString(req.query.status, 'status', 30);
    const allowedStatus = new Set(['pending', 'claimed', 'expired']);

    if (status && !allowedStatus.has(status)) {
      return badRequest(res, 'status tidak valid');
    }

    const redemptions = await prisma.rewardRedemption.findMany({
      where: status ? { status } : {},
      include: {
        reward: { select: { id: true, name: true, points_required: true } },
        customer: {
          select: {
            id: true,
            name: true,
            phone_number: true,
            user: { select: { phone_number: true, email: true } },
          },
        },
      },
      orderBy: { id: 'desc' },
      take: 200,
    });

    res.json(redemptions);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateRedemptionStatus(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const status = parseRequiredString(req.body.status, 'status', 30);
    const allowed = new Set(['pending', 'claimed', 'expired']);

    if (!allowed.has(status)) {
      return badRequest(res, 'status tidak valid');
    }

    const redemption = await prisma.rewardRedemption.update({
      where: { id },
      data: {
        status,
        redeemed_at: status === 'claimed' ? new Date() : null,
      },
      include: {
        reward: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, phone_number: true } },
      },
    });

    res.json(redemption);
  } catch (error) {
    handleError(res, error);
  }
}

module.exports = {
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  listAdminCustomers,
  createAdminCustomer,
  updateAdminCustomer,
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
