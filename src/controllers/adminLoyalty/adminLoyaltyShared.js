const prisma = require('../../lib/prisma');
const {
  createAccountActivationToken,
  invalidatePendingActivationTokens,
} = require('../../services/accountActivationService');
const { sendActivationEmail } = require('../../services/emailService');
const { respondWithServerError } = require('../../lib/serverError');
const { ValidationError } = require('../../lib/validationError');
const {
  endOfWibDay,
  isWibDateOnlyInput,
  parseWibInstant,
  startOfWibDay,
} = require('../../lib/wibDate');

// L-7: konfigurasi, parser, order-by builder, dan helper audit yang dipakai
// lebih dari satu controller domain dikumpulkan di satu modul supaya
// adminLoyaltyController.js bisa kembali menjadi composition root yang tipis.
// Isi fungsinya dipindahkan apa adanya dari file lama -- tidak ada perubahan
// perilaku, pesan error, maupun tanda tangan fungsi.

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

// M-4 (lanjutan): batas rentang tanggal dashboard SELALU merupakan batas hari
// kalender WIB, bukan hari kalender zona runtime.
//
// Versi lama memakai `date.setHours(...)` yang mengikuti zona proses. Di Vercel
// (UTC) filter "1-31 Agustus" sebenarnya mengambil 1 Agu 07:00 WIB s/d 1 Sep
// 06:59 WIB: transaksi dini hari 1 Agustus hilang dari laporan dan transaksi
// dini hari 1 September ikut terhitung. Sisi sync sudah benar memakai WIB
// (lihat runchiseSyncCron dan syncService.parseRunchiseDate), jadi sisi baca
// yang memakai UTC membuat laporan tidak cocok dengan data yang disinkronkan.
//
// Kontraknya kini seragam untuk semua bentuk input: nilai diurai menjadi satu
// instant, ditentukan hari kalender WIB mana yang memuatnya, lalu dijepit ke
// awal (00:00:00.000 WIB) atau akhir (23:59:59.999 WIB) hari itu. `from`/`to`
// dengan demikian selalu berupa rentang hari WIB penuh yang inklusif, persis
// seperti yang dimaksud <input type="date"> pada dashboard.
//
// Catatan: `parseOptionalDate` sengaja TIDAK ikut diubah. Fungsi itu dipakai
// untuk `dob` (kolom @db.Date) yang harus tetap ditambatkan ke UTC agar tanggal
// lahir tidak bergeser satu hari saat disimpan.
function parseDateBoundary(value, fieldName, endOfDay = false) {
  if (value === undefined || value === null || value === '') return null;

  const instant = parseWibInstant(value);
  if (!instant) {
    throw new ValidationError(`${fieldName} harus berupa tanggal valid`);
  }

  return endOfDay ? endOfWibDay(instant) : startOfWibDay(instant);
}

// M-4 (lanjutan): jendela penjadwalan (RedeemMenuItem.start_at / end_at) juga
// mengikuti kalender WIB.
//
// Jendelanya inklusif di kedua ujung (`start_at <= now` dan `end_at >= now`,
// lihat redeemMenuRoutes dan nextRewardService), jadi "berlaku 1-31 Agustus"
// berarti 1 Agu 00:00:00.000 WIB s/d 31 Agu 23:59:59.999 WIB. Dengan
// `parseOptionalDate`, '2026-08-01' menjadi tengah malam UTC sehingga item baru
// muncul pukul 07:00 WIB -- dan pada tanggal akhir item menghilang pukul 07:00
// WIB, tujuh jam sebelum harinya benar-benar berakhir. Ini menyamakan
// perilakunya dengan promo Runchise yang sudah benar (syncService:
// parseRunchiseDate(start, false) / parseRunchiseDate(end, true)).
//
// Nilai yang menyebut jam secara eksplisit TIDAK dijepit ke batas hari: jadwal
// seperti '2026-08-01T14:00:00+07:00' memang berarti instant itu persis.
// Bentuk ISO tanpa offset dibaca sebagai jam WIB, bukan jam zona runtime.
function parseScheduleBoundary(value, fieldName, endOfDay = false) {
  // `undefined` berarti field tidak dikirim; dipertahankan agar Prisma
  // memperlakukannya sebagai "tidak diubah", sama seperti parseOptionalDate.
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const instant = parseWibInstant(value);
  if (!instant) {
    throw new ValidationError(`${fieldName} harus berupa tanggal valid`);
  }

  if (!isWibDateOnlyInput(value)) return instant;

  return endOfDay ? endOfWibDay(instant) : startOfWibDay(instant);
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

module.exports = {
  DEFAULT_PB1_RATE,
  DEFAULT_REWARD_THRESHOLD,
  DEFAULT_RUNCHISE_PARENT_BRAND_ID,
  DEFAULT_RUNCHISE_REDEEM_SUB_BRAND_ID,
  ADMIN_USER_ROLES,
  ADMIN_USER_UPDATE_FIELDS,
  getPositiveEnvInt,
  getPb1Rate,
  addRedeemPriceBreakdown,
  getDefaultRewardThreshold,
  sendCustomerActivationLink,
  getRedeemCatalogConfig,
  getAdminCustomerInclude,
  getCustomerAuditSnapshot,
  comparableAuditValue,
  auditValuesEqual,
  sortedLocationIds,
  getActualCustomerChangedFields,
  badRequest,
  parsePositiveInt,
  parseNonNegativeInt,
  parseBoolean,
  parseOptionalString,
  parseOptionalEmail,
  parseRequiredString,
  parseSortOrder,
  buildAdminUserOrderBy,
  buildAdminCustomerOrderBy,
  buildRedeemItemOrderBy,
  normalizePhone,
  parseAdminUserRole,
  parseOptionalDate,
  parseDateBoundary,
  parseScheduleBoundary,
  parseOptionalNumber,
  parseLocationIds,
  normalizeReportName,
  getDefaultRedeemCategoryId,
  parseCustomerStatus,
  parseCustomerGender,
  handleError,
};
