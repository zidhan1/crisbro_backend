// Mengimpor Prisma untuk akses database lokal
const prisma = require('../lib/prisma');

// Prisma.sql/Prisma.join dipakai untuk menyusun bulk upsert yang aman parameter
const { Prisma } = require('@prisma/client');

// Mengimpor service Runchise (API eksternal)
const {
  fetchAllCustomers,
  fetchAllCustomersAcrossLocations,
  fetchAllSalesTransactions,
  fetchAllSubBrands,
  fetchAllLocations,
  fetchCustomersPage,
  fetchPromosPage,
} = require('./runchiseService');
const {
  importProducts: importCrisbarProducts,
} = require('../../scripts/importSelectedCrisbarProducts');

const DEFAULT_PROMO_LIFESPAN_DAYS = 90;
const POS_CHANNEL = 'pos';
const TARGET_PROMO_PARENT_BRAND_RUNCHISE_ID = 750;
const TARGET_PROMO_SUB_BRAND_RUNCHISE_ID = 1041;
const TARGET_PROMO_SUB_BRAND_IDS = new Set([TARGET_PROMO_SUB_BRAND_RUNCHISE_ID]);
const CUSTOMER_PROMO_CHANNELS = new Set(['grabfood', 'gofood', 'shopeefood']);
const PROMO_PAGE_SIZE = 50;
const PROMO_WRITE_CHUNK_SIZE = 20;
const PROMO_MAX_PAGES = 1000;

// Sama dengan default kolom CustomerPoint.next_reward_threshold di schema.
const DEFAULT_NEXT_REWARD_THRESHOLD = 2000;

// Jumlah baris per statement bulk upsert poin. Cukup besar untuk menekan
// jumlah round trip, cukup kecil untuk menjaga ukuran query tetap wajar.
const CUSTOMER_POINT_UPSERT_CHUNK = 500;

function normalizeChannel(rawChannel) {
  return String(rawChannel ?? '')
    .trim()
    .toLowerCase();
}

function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function normalizeLocationName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isTruthyApiFlag(value) {
  return (
    value === true ||
    value === 1 ||
    String(value).trim().toLowerCase() === 'true'
  );
}

function classifyRunchiseLocation(loc) {
  const branchType = String(loc?.branch_type ?? '')
    .trim()
    .toLowerCase();
  const status = String(loc?.status ?? '')
    .trim()
    .toLowerCase();
  const isDeleted = isTruthyApiFlag(loc?.deleted);

  return {
    is_active: status === 'activated' && !isDeleted,
    is_outlet: branchType === 'outlet',
  };
}

function mapRunchiseLocationToLocalData(loc, brandId) {
  const visibility = classifyRunchiseLocation(loc);

  return {
    brand_id: brandId,
    runchise_id: Number(loc.id),
    name: loc.name,
    address: loc.shipping_address ?? loc.address ?? null,
    city: loc.city ?? null,
    province: loc.province ?? null,
    phone: loc.contact_number
      ? `+62${String(loc.contact_number).replace(/^0/, '')}`
      : null,
    latitude: loc.latitude ? parseFloat(loc.latitude) : null,
    longitude: loc.longitude ? parseFloat(loc.longitude) : null,
    ...visibility,
  };
}

function phoneVariants(normalizedPhone) {
  if (!normalizedPhone) return [];

  return Array.from(
    new Set([normalizedPhone, `0${normalizedPhone}`, `62${normalizedPhone}`]),
  );
}

function isPosChannel(channel) {
  return normalizeChannel(channel) === POS_CHANNEL;
}

function isOnlineChannel(channel) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return false;
  return normalized !== POS_CHANNEL;
}

function parseRunchiseDate(value, endOfDay = false) {
  if (!value) return null;

  const parts = String(value).split('/');
  if (parts.length !== 3) return null;

  const [day, month, year] = parts.map(Number);
  if (!day || !month || !year) return null;

  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getEffectivePromoStatus(promo, now) {
  const start = parseRunchiseDate(promo.start_date, false);
  let end = parseRunchiseDate(promo.end_date, true);

  if (promo.deleted) return 'inactive';

  if (!end && start) {
    end = addDays(start, DEFAULT_PROMO_LIFESPAN_DAYS);
  }

  if (end && end.getTime() < now.getTime()) return 'completed';
  if (start && start.getTime() > now.getTime()) return 'inactive';

  return promo.status || 'active';
}

// ===================== SYNC CUSTOMERS =====================

// Sync customer dari Runchise → database lokal
// locationId hanya menjadi cadangan owner_location_id ketika Runchise tidak
// mengirimkannya. Default lama 1 membuat customer tanpa outlet dipetakan ke
// outlet yang tidak ada, sekaligus membuat baris Location id 1 palsu.
// Daftar outlet Runchise yang akan disapu, dengan cadangan bila endpoint
// locations tidak terbaca.
async function getRunchiseSyncLocationIds() {
  const locations = await fetchAllLocations();
  const locationIds = [
    ...new Set(
      locations
        .map((location) => Number(location.id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  if (locationIds.length > 0) return locationIds;

  // Fallback lama ke ID 1 menunjuk outlet yang tidak dimiliki Crisbar, sehingga
  // sync tampak sukses padahal tidak memproses satu customer pun.
  const fallbackLocationId = Number(process.env.RUNCHISE_SYNC_LOCATION_ID);

  if (!Number.isInteger(fallbackLocationId) || fallbackLocationId <= 0) {
    throw new Error(
      'Tidak ada lokasi Runchise yang dapat dibaca dan RUNCHISE_SYNC_LOCATION_ID belum diisi',
    );
  }

  return [fallbackLocationId];
}

async function syncCustomers(locationId = null) {
  const fallbackLocationId = parseRunchiseId(locationId);
  const locationIds = await getRunchiseSyncLocationIds();

  // Hanya ID customer yang disimpan, bukan objeknya. Versi lama memanggil
  // fetchAllCustomersAcrossLocations() yang menumpuk seluruh hasil lebih dulu:
  // endpoint Runchise melayani sampai 10.000 baris per outlet, jadi 32 outlet
  // berarti hingga 320.000 objek customer sekaligus di memori sebelum satu pun
  // diproses. Di function serverless yang memorinya terbatas itu berisiko
  // crash. Sekarang tiap halaman langsung diproses lalu dilepas.
  //
  // Dedupe tetap dibutuhkan karena satu customer bisa muncul di beberapa outlet.
  // Aman diproses per halaman: API mengembalikan location_ids yang lengkap pada
  // setiap respons, apa pun outlet yang ditanya, sehingga keanggotaan outlet
  // tidak hilang walau customernya hanya diproses sekali.
  const processedCustomerIds = new Set();
  let synced = 0;
  let skippedConflicts = 0;

  for (const outletId of locationIds) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const data = await fetchCustomersPage(outletId, page);
      const customers = Array.isArray(data.customers) ? data.customers : [];

      for (const customer of customers) {
        const runchiseId = Number(customer.id);
        if (!Number.isInteger(runchiseId) || runchiseId <= 0) continue;
        if (processedCustomerIds.has(runchiseId)) continue;

        processedCustomerIds.add(runchiseId);

        const result = await upsertRunchiseCustomer(
          customer,
          fallbackLocationId,
        );

        if (result.status === 'skipped_conflict') {
          skippedConflicts++;
        } else {
          synced++;
        }
      }

      hasMore = data.paging?.next_page != null;
      page++;
    }
  }

  return {
    synced,
    total: processedCustomerIds.size,
    skipped_conflicts: skippedConflicts,
  };
}

// Upsert satu customer Runchise ke database lokal.
//
// Dipakai baik oleh syncCustomers (impor penuh lewat CLI) maupun worker job
// customerImportSyncService yang memproses satu halaman API per request agar
// muat di batas waktu serverless.
async function upsertRunchiseCustomer(c, fallbackLocationId = null) {
  // Pastikan brand sudah ada di database
  await prisma.brand.upsert({
    where: { id: c.brand_id },
    update: {},
    create: { id: c.brand_id, name: `Brand ${c.brand_id}` },
  });

  const ownerLocationId = Number(c.owner_location_id) || fallbackLocationId;
  const ownerLocationName = c.owner_location?.name ?? `Outlet ${ownerLocationId}`;
  const locationIds = [
    ...new Set([
      ...(c.location_ids ?? []),
      ...(ownerLocationId ? [ownerLocationId] : []),
    ].map(Number).filter((id) => Number.isInteger(id) && id > 0)),
  ];

  for (const locationId of locationIds) {
    await prisma.location.upsert({
      where: { id: locationId },
      update: {
        ...(locationId === ownerLocationId && { name: ownerLocationName }),
        brand_id: c.brand_id,
        runchise_id: locationId,
      },
      create: {
        id: locationId,
        brand_id: c.brand_id,
        runchise_id: locationId,
        name:
          locationId === ownerLocationId
            ? ownerLocationName
            : `Outlet ${locationId}`,
        is_active: true,
        is_outlet: true,
      },
    });
  }

  const normalizedPhone = normalizePhone(c.phone_number);
  const phoneNumberVariants = phoneVariants(normalizedPhone);
  const syncedAt = new Date();

  // Mapping data customer dari Runchise ke format lokal
  const payload = {
    runchise_id: Number(c.id),
    runchise_location_id: ownerLocationId,
    runchise_sync_status: 'synced',
    runchise_sync_error: null,
    runchise_synced_at: syncedAt,
    runchise_created_at: parseIsoDate(c.created_at),
    runchise_updated_at: parseIsoDate(c.updated_at),
    name: c.name,
    phone_number: normalizedPhone,
    normalized_phone_number: normalizedPhone,
    phone_number_country_code: c.phone_number_country_code ?? 62,
    address: c.address ?? null,
    province: c.province ?? null,
    city: c.city ?? null,
    country: c.country ?? null,
    postal_code: c.postal_code ?? null,
    dob: c.dob && !isNaN(new Date(c.dob)) ? new Date(c.dob) : null,
    gender: c.gender ?? 'unknown',
    status: c.status ?? 'active',
    balance: parseFloat(c.balance ?? 0),
    brand_id: c.brand_id,
    owner_location_id: ownerLocationId,
  };

  const [
    existingByRunchiseId,
    existingCustomerByPhone,
    existingUserByPhone,
  ] = await Promise.all([
    prisma.customer.findFirst({
      where: { runchise_id: c.id },
      include: {
        user: { select: { id: true, phone_number: true, role: true } },
      },
    }),
    phoneNumberVariants.length > 0
      ? prisma.customer.findFirst({
          where: {
            OR: [
              { phone_number: { in: phoneNumberVariants } },
              { user: { phone_number: { in: phoneNumberVariants } } },
            ],
          },
        })
      : null,
    phoneNumberVariants.length > 0
      ? prisma.user.findFirst({
          where: { phone_number: { in: phoneNumberVariants } },
          include: { customer: true },
        })
      : null,
  ]);

  const existingByPhone =
    existingCustomerByPhone || existingUserByPhone?.customer || null;

  if (
    existingUserByPhone &&
    (!existingUserByPhone.customer ||
      existingUserByPhone.customer.id !== existingByPhone?.id)
  ) {
    console.warn(
      `Sync customer skipped: phone=${normalizedPhone} sudah dipakai user_id=${existingUserByPhone.id} role=${existingUserByPhone.role} yang tidak cocok dengan customer Runchise.`,
    );
    return { status: 'skipped_conflict', reason: 'phone_used_by_other_user' };
  }

  if (
    existingByRunchiseId &&
    existingByPhone &&
    existingByRunchiseId.id !== existingByPhone.id
  ) {
    console.warn(
      `Sync customer skipped: runchise_id=${c.id} cocok dengan customer_id=${existingByRunchiseId.id}, tetapi phone cocok dengan customer_id=${existingByPhone.id}.`,
    );
    return { status: 'skipped_conflict', reason: 'runchise_id_phone_mismatch' };
  }

  if (
    existingByPhone &&
    existingByPhone.runchise_id !== null &&
    existingByPhone.runchise_id !== c.id
  ) {
    console.warn(
      `Sync customer skipped: phone=${normalizedPhone} sudah terhubung ke runchise_id=${existingByPhone.runchise_id}, bukan ${c.id}.`,
    );
    return { status: 'skipped_conflict', reason: 'phone_linked_to_other_runchise_id' };
  }

  const existing = existingByRunchiseId || existingByPhone;

  // Update jika sudah ada, create jika belum
  if (existing) {
    const operations = [
      prisma.customer.update({
        where: { id: existing.id },
        data: payload,
      }),
      prisma.user.update({
        where: { id: existing.user_id },
        data: { phone_number: payload.phone_number },
      }),
      prisma.customerLocation.deleteMany({
        where: { customer_id: existing.id },
      }),
    ];
    if (locationIds.length > 0) {
      operations.push(
        prisma.customerLocation.createMany({
          data: locationIds.map((location_id) => ({
            customer_id: existing.id,
            location_id,
          })),
          skipDuplicates: true,
        }),
      );
    }
    await prisma.$transaction(operations);

    return { status: 'updated', customer_id: existing.id };
  }

  const createdUser = await prisma.user.create({
    data: {
      phone_number: normalizedPhone,
      password_hash: '',
      activation_status: 'pending_activation',
      role: 'customer',
      customer: {
        create: {
          ...payload,
          ...(locationIds.length > 0 && {
            customer_locations: {
              create: locationIds.map((location_id) => ({ location_id })),
            },
          }),
        },
      },
    },
    include: { customer: { select: { id: true } } },
  });

  return { status: 'created', customer_id: createdUser.customer?.id ?? null };
}

function parseIsoDate(value) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseInteger(value, fallback = 0) {
  const number = parseNumber(value, fallback);
  return Number.isInteger(number) ? number : Math.trunc(number);
}

// Mengembalikan ID Runchise yang valid, atau null bila tidak dapat dipakai.
// Sengaja tidak memiliki fallback angka: outlet Crisbar di Runchise memakai ID
// 4424-9854, sehingga fallback seperti 1 akan menunjuk lokasi yang bukan milik
// brand ini dan membuat sync mengembalikan data kosong.
function parseRunchiseId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function formatPhoneWithCountryCode(phoneNumber, countryCode = 62) {
  if (!phoneNumber) return null;

  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) return null;

  const code = String(countryCode || 62).replace(/\D/g, '') || '62';
  if (digits.startsWith(code)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${code}${digits.slice(1)}`;

  return `+${code}${digits}`;
}

function getOrderPurchaseAmount(sale) {
  const payments = Array.isArray(sale.payments) ? sale.payments : [];
  if (payments.length > 0) {
    return payments.reduce(
      (total, payment) => total + parseNumber(payment.amount_receive),
      0,
    );
  }

  return parseNumber(
    sale.net_sales_after_tax ??
      sale.amount_receive ??
      sale.net_sales ??
      sale.subtotal ??
      sale.gross_sales,
  );
}

// ===================== SYNC CUSTOMER POINTS =====================

// Menulis saldo poin dalam beberapa statement bulk upsert. Versi lama mengirim
// satu prisma.customerPoint.upsert per customer di dalam satu $transaction,
// sehingga 16 ribu customer berarti 16 ribu round trip dan hampir pasti habis
// waktu. Pemanggil wajib memastikan customerId unik karena ON CONFLICT tidak
// boleh menyentuh baris yang sama dua kali dalam satu statement.
async function bulkUpsertCustomerPoints(rows) {
  let written = 0;

  for (
    let index = 0;
    index < rows.length;
    index += CUSTOMER_POINT_UPSERT_CHUNK
  ) {
    const chunk = rows.slice(index, index + CUSTOMER_POINT_UPSERT_CHUNK);
    const tuples = Prisma.join(
      chunk.map(
        (row) =>
          Prisma.sql`(${row.customerId}, ${row.totalPoint}, ${row.availablePoint}, ${DEFAULT_NEXT_REWARD_THRESHOLD}, CURRENT_TIMESTAMP)`,
      ),
    );

    // next_reward_threshold sengaja tidak ikut diperbarui agar ambang batas
    // yang sudah disesuaikan per customer tidak tertimpa nilai default.
    written += await prisma.$executeRaw`
      INSERT INTO "CustomerPoint" (
        "customer_id", "total_point", "available_point",
        "next_reward_threshold", "updated_at"
      )
      VALUES ${tuples}
      ON CONFLICT ("customer_id") DO UPDATE SET
        "total_point" = EXCLUDED."total_point",
        "available_point" = EXCLUDED."available_point",
        "updated_at" = CURRENT_TIMESTAMP
    `;
  }

  return written;
}

// Sync poin customer dari Runchise ke database lokal.
//
// Tanpa locationId, sync mencakup SELURUH outlet. Ini penting: Crisbar punya 29
// lokasi di Runchise (ID 4424-9854) dan customer tersebar di semuanya, sedangkan
// versi lama memakai default locationId = 1 yang bukan outlet Crisbar sehingga
// tidak ada satu pun saldo poin yang ikut ter-update.
//
// locationId hanya diisi bila memang ingin membatasi ke satu outlet, misalnya
// dari endpoint admin manual yang harus selesai dalam batas waktu serverless.
async function syncCustomerPoints({ locationId = null } = {}) {
  const targetLocationId = parseRunchiseId(locationId);

  // Ambil data dari API + database sekaligus
  const [runchiseCustomers, localCustomers] = await Promise.all([
    targetLocationId
      ? fetchAllCustomers(targetLocationId)
      : fetchAllCustomersAcrossLocations(),
    prisma.customer.findMany({
      where: { runchise_id: { not: null } },
      select: { id: true, runchise_id: true },
    }),
  ]);

  // Mapping runchise_id → local_id (biar cepat, tidak query DB berulang)
  const runchiseToLocal = new Map(
    localCustomers.map((c) => [c.runchise_id, c.id]),
  );

  // Dikunci per customer lokal supaya satu customer yang muncul di beberapa
  // outlet tetap menghasilkan tepat satu baris untuk ON CONFLICT.
  const pointsByCustomerId = new Map();
  let unmatched = 0;

  for (const c of runchiseCustomers) {
    const localId = runchiseToLocal.get(parseRunchiseId(c.id));
    if (!localId) {
      unmatched++;
      continue;
    }

    // Runchise/POS adalah source of truth poin. Karena API riwayat poin
    // Runchise belum tersedia, saldo lokal hanya menjadi mirror nilai terbaru.
    pointsByCustomerId.set(localId, {
      customerId: localId,
      totalPoint: parseInteger(c.total_point, 0),
      availablePoint: parseInteger(c.available_point, 0),
    });
  }

  const rows = [...pointsByCustomerId.values()];
  const synced = await bulkUpsertCustomerPoints(rows);

  return {
    scope: targetLocationId ? `location:${targetLocationId}` : 'all-locations',
    synced,
    matched: rows.length,
    unmatched,
    total: runchiseCustomers.length,
    local_customers: localCustomers.length,
  };
}

// Menurunkan saldo poin dari tabel staging RunchiseLocationCustomer, bukan dari
// API. Staging sudah memuat total_point/available_point untuk ke-29 outlet dari
// endpoint yang sama, sehingga cakupannya lengkap tanpa satu pun request HTTP.
// Ini membuat job harian selesai dalam hitungan milidetik, sementara refresh
// penuh dari API dijalankan lewat scripts/syncCustomerPoints.js yang tidak
// terikat batas waktu serverless.
//
// Poin Runchise diperlakukan sebagai nilai global per customer: objek customer
// yang sama muncul di setiap listing outlet yang ia ikuti dan membawa
// location_ids lengkap, jadi barisnya cukup dipilih satu yang paling baru.
// divergent_customers memverifikasi asumsi itu setiap kali sync berjalan; nilai
// di atas nol berarti poin ternyata berbeda antar outlet dan strategi merge ini
// harus ditinjau ulang.
async function syncCustomerPointsFromStaging() {
  const [divergence] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS divergent_customers
    FROM (
      SELECT c."id"
      FROM "Customer" c
      JOIN "RunchiseLocationCustomer" rlc
        ON rlc."runchise_customer_id" = c."runchise_id"
      WHERE c."runchise_id" IS NOT NULL
      GROUP BY c."id"
      HAVING MIN(COALESCE(rlc."total_point", 0))
               <> MAX(COALESCE(rlc."total_point", 0))
          OR MIN(COALESCE(rlc."available_point", 0))
               <> MAX(COALESCE(rlc."available_point", 0))
    ) divergent
  `;

  // DISTINCT ON memilih satu baris staging per customer, diambil dari snapshot
  // terbaru. Dipisahkan ke CTE agar ORDER BY tetap milik SELECT dan tidak
  // bercampur dengan ON CONFLICT milik INSERT.
  const synced = await prisma.$executeRaw`
    WITH latest_points AS (
      SELECT DISTINCT ON (c."id")
        c."id" AS customer_id,
        COALESCE(rlc."total_point", 0) AS total_point,
        COALESCE(rlc."available_point", 0) AS available_point
      FROM "Customer" c
      JOIN "RunchiseLocationCustomer" rlc
        ON rlc."runchise_customer_id" = c."runchise_id"
      WHERE c."runchise_id" IS NOT NULL
      ORDER BY
        c."id",
        rlc."updated_at" DESC NULLS LAST,
        rlc."source_location_id" DESC
    )
    INSERT INTO "CustomerPoint" (
      "customer_id", "total_point", "available_point",
      "next_reward_threshold", "updated_at"
    )
    SELECT
      "customer_id",
      "total_point",
      "available_point",
      ${DEFAULT_NEXT_REWARD_THRESHOLD}::int,
      CURRENT_TIMESTAMP
    FROM latest_points
    ON CONFLICT ("customer_id") DO UPDATE SET
      "total_point" = EXCLUDED."total_point",
      "available_point" = EXCLUDED."available_point",
      "updated_at" = CURRENT_TIMESTAMP
  `;

  return {
    scope: 'all-locations',
    source: 'staging',
    synced,
    divergent_customers: divergence?.divergent_customers ?? 0,
  };
}

// SUM() Postgres atas kolom int menghasilkan bigint, yang diterima Prisma
// sebagai BigInt dan tidak dapat diserialisasi JSON.stringify.
function bigIntToNumber(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

// Diagnostik read-only untuk saldo poin. Tidak menulis apa pun.
//
// Menjawab satu pertanyaan yang menentukan strategi merge lintas outlet: apakah
// poin Runchise bersifat global per customer, atau berbeda per outlet?
//
// fetchAllCustomersAcrossLocations menggabungkan dengan pola {...existing,
// ...customer}, sehingga outlet yang diproses terakhir menang. Bila poin
// ternyata dilaporkan hanya pada outlet asal customer dan 0 di outlet lain,
// penggabungan itu dapat menimpa nilai benar dengan 0 dan mengecilkan saldo
// tanpa gejala apa pun. divergent_customers membuktikan mana yang terjadi.
async function inspectCustomerPointSources() {
  // 1. Apakah poin berbeda antar outlet? Dihitung atas SELURUH customer staging
  //    yang terdaftar di lebih dari satu outlet, bukan hanya yang punya akun.
  const [spread] = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS multi_outlet_customers,
      COUNT(*) FILTER (
        WHERE min_total <> max_total OR min_available <> max_available
      )::int AS divergent_customers,
      COALESCE(SUM(max_total - min_total), 0)::bigint AS total_point_spread
    FROM (
      SELECT
        "runchise_customer_id",
        MIN(COALESCE("total_point", 0)) AS min_total,
        MAX(COALESCE("total_point", 0)) AS max_total,
        MIN(COALESCE("available_point", 0)) AS min_available,
        MAX(COALESCE("available_point", 0)) AS max_available
      FROM "RunchiseLocationCustomer"
      GROUP BY "runchise_customer_id"
      HAVING COUNT(*) > 1
    ) multi
  `;

  // 2. Berapa hasilnya bila memakai strategi merge berbeda, khusus customer yang
  //    punya akun lokal. Bila poin global, kolom max dan sum akan sama.
  const [strategies] = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS matched_customers,
      COALESCE(SUM(max_total), 0)::bigint AS total_if_max,
      COALESCE(SUM(sum_total), 0)::bigint AS total_if_sum,
      COALESCE(SUM(max_available), 0)::bigint AS available_if_max,
      COALESCE(SUM(sum_available), 0)::bigint AS available_if_sum,
      COUNT(*) FILTER (WHERE max_total > 0)::int AS customers_with_points
    FROM (
      SELECT
        c."id",
        MAX(COALESCE(rlc."total_point", 0)) AS max_total,
        SUM(COALESCE(rlc."total_point", 0)) AS sum_total,
        MAX(COALESCE(rlc."available_point", 0)) AS max_available,
        SUM(COALESCE(rlc."available_point", 0)) AS sum_available
      FROM "Customer" c
      JOIN "RunchiseLocationCustomer" rlc
        ON rlc."runchise_customer_id" = c."runchise_id"
      WHERE c."runchise_id" IS NOT NULL
      GROUP BY c."id"
    ) per_customer
  `;

  // 3. Nilai yang tersimpan sekarang, untuk dibandingkan dengan dua di atas.
  const [stored] = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS point_rows,
      COALESCE(SUM("total_point"), 0)::bigint AS total_point,
      COALESCE(SUM("available_point"), 0)::bigint AS available_point,
      COUNT(*) FILTER (WHERE "total_point" > 0)::int AS customers_with_points,
      MAX("updated_at") AS last_updated_at
    FROM "CustomerPoint"
  `;

  const [staleness] = await prisma.$queryRaw`
    SELECT
      COUNT(DISTINCT "runchise_customer_id")::int AS unique_staging_customers,
      COUNT(*)::int AS staging_rows,
      MAX("imported_at") AS last_import_at
    FROM "RunchiseLocationCustomer"
  `;

  return {
    staging: {
      staging_rows: staleness?.staging_rows ?? 0,
      unique_customers: staleness?.unique_staging_customers ?? 0,
      last_import_at: staleness?.last_import_at ?? null,
    },
    divergence: {
      multi_outlet_customers: spread?.multi_outlet_customers ?? 0,
      divergent_customers: spread?.divergent_customers ?? 0,
      total_point_spread: bigIntToNumber(spread?.total_point_spread),
    },
    merge_strategies: {
      matched_customers: strategies?.matched_customers ?? 0,
      customers_with_points: strategies?.customers_with_points ?? 0,
      total_if_max: bigIntToNumber(strategies?.total_if_max),
      total_if_sum: bigIntToNumber(strategies?.total_if_sum),
      available_if_max: bigIntToNumber(strategies?.available_if_max),
      available_if_sum: bigIntToNumber(strategies?.available_if_sum),
    },
    stored_now: {
      point_rows: stored?.point_rows ?? 0,
      total_point: bigIntToNumber(stored?.total_point),
      available_point: bigIntToNumber(stored?.available_point),
      customers_with_points: stored?.customers_with_points ?? 0,
      last_updated_at: stored?.last_updated_at ?? null,
    },
  };
}

// ===================== SYNC SALES TRANSACTION REPORT =====================

function buildSalesTransactionParams({
  locationId,
  startDate,
  endDate,
  status,
  paymentMethodIds,
} = {}) {
  const params = {};
  const numericLocationId = Number(locationId);

  if (Number.isInteger(numericLocationId) && numericLocationId > 0) {
    params.location_id = numericLocationId;
  }
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  if (status) params.status = status;
  if (paymentMethodIds) params.payment_method_ids = paymentMethodIds;

  return params;
}

function mapSalesTransactionReportData(
  sale,
  runchiseCustomer,
  localCustomer,
  sourceLocationId,
) {
  const metadata = sale.metadata || {};
  const customerPoint = localCustomer?.customer_point;
  const ownerLocation = localCustomer?.owner_location;
  const phoneCountryCode =
    sale.customer_phone_number_country_code ??
    runchiseCustomer?.phone_number_country_code ??
    localCustomer?.phone_number_country_code ??
    62;
  const phoneNumber =
    sale.customer_phone_number ??
    runchiseCustomer?.phone_number ??
    localCustomer?.phone_number;

  return {
    source_location_id: Number(sourceLocationId),
    runchise_sales_transaction_id: Number(sale.id),
    runchise_customer_id: sale.customer_id ? Number(sale.customer_id) : null,
    customer_id: localCustomer?.id ?? null,
    runchise_location_id: sale.location_id ? Number(sale.location_id) : null,
    nama_pelanggan:
      sale.customer_name ?? runchiseCustomer?.name ?? localCustomer?.name ?? null,
    no_telepon: formatPhoneWithCountryCode(phoneNumber, phoneCountryCode),
    lokasi_dibuat:
      runchiseCustomer?.owner_location?.name ?? ownerLocation?.name ?? null,
    pelanggan_sejak:
      parseIsoDate(runchiseCustomer?.created_at) ??
      localCustomer?.member_since ??
      null,
    poin_pelanggan: parseInteger(
      runchiseCustomer?.available_point ??
        customerPoint?.available_point ??
        metadata.available_point ??
        metadata.total_point,
    ),
    tanggal_transaksi: parseIsoDate(
      sale.sales_time ?? sale.sales_time_date ?? sale.created_at,
    ),
    nama_outlet: sale.location_name ?? sale.location?.name ?? null,
    tipe_order: sale.order_type_name ?? null,
    pembelian_per_order: getOrderPurchaseAmount(sale),
    penambahan_poin: parseInteger(metadata.earned_point),
    penggunaan_poin: parseNumber(metadata.redeemed_point),
    sales_no: sale.sales_no ?? null,
    receipt_no: sale.receipt_no ?? null,
    status: sale.status ?? null,
    is_deleted: Boolean(sale.deleted),
    nominal_transaksi: parseNumber(
      sale.net_sales_after_tax ??
        sale.net_sales ??
        sale.new_net_sales ??
        sale.subtotal ??
        sale.gross_sales,
    ),
    jumlah_diterima: (Array.isArray(sale.payments) ? sale.payments : []).reduce(
      (total, payment) => total + parseNumber(payment.amount_receive),
      0,
    ),
    jumlah_kembalian: (Array.isArray(sale.payments) ? sale.payments : []).reduce(
      (total, payment) => total + parseNumber(payment.change),
      0,
    ),
    sumber_nominal:
      Array.isArray(sale.payments) && sale.payments.length > 0
        ? 'payments.amount_receive'
        : 'fallback_transaction_nominal',
    payment_methods:
      sale.payment_method_names ??
      (Array.isArray(sale.payments)
        ? [...new Set(sale.payments.map((p) => p.payment_method_name).filter(Boolean))].join(', ') || null
        : null),
    customer_snapshot_at: new Date(),
    raw: sale,
  };
}

async function syncSalesTransactionReports(locationId = null, options = {}) {
  const targetLocationId = parseRunchiseId(locationId);

  // source_location_id ikut menyusun identitas unik baris laporan, sehingga
  // outlet sumber wajib diketahui. Tanpa itu Number(null) akan tersimpan
  // sebagai 0 dan menimpa transaksi outlet lain di composite key yang sama.
  if (!targetLocationId) {
    return {
      skipped: true,
      reason:
        'RUNCHISE_SYNC_LOCATION_ID belum diisi dengan ID outlet Runchise yang valid',
      synced: 0,
      skipped_rows: 0,
      total: 0,
    };
  }

  const params = buildSalesTransactionParams({
    locationId: targetLocationId,
    startDate: options.startDate ?? options.start_date ?? options.from,
    endDate: options.endDate ?? options.end_date ?? options.to,
    status: options.status,
    paymentMethodIds: options.paymentMethodIds ?? options.payment_method_ids,
  });
  const [salesTransactions, runchiseCustomers] = await Promise.all([
    fetchAllSalesTransactions(params),
    fetchAllCustomers(targetLocationId),
  ]);
  const runchiseCustomerById = new Map(
    runchiseCustomers.map((customer) => [Number(customer.id), customer]),
  );
  const runchiseCustomerIds = Array.from(
    new Set(
      salesTransactions
        .map((sale) => Number(sale.customer_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  );
  const localCustomers =
    runchiseCustomerIds.length > 0
      ? await prisma.customer.findMany({
          where: { runchise_id: { in: runchiseCustomerIds } },
          include: {
            owner_location: { select: { id: true, name: true, city: true } },
            customer_point: true,
          },
        })
      : [];
  const localCustomerByRunchiseId = new Map(
    localCustomers.map((customer) => [Number(customer.runchise_id), customer]),
  );

  let synced = 0;
  let skipped = 0;
  let skippedZeroPoints = 0;
  let deletedZeroPoints = 0;

  for (const sale of salesTransactions) {
    const saleId = Number(sale.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      skipped++;
      continue;
    }

    const runchiseCustomerId = Number(sale.customer_id);
    const runchiseCustomer = runchiseCustomerById.get(runchiseCustomerId);
    const localCustomer = localCustomerByRunchiseId.get(runchiseCustomerId);
    const data = mapSalesTransactionReportData(
      sale,
      runchiseCustomer,
      localCustomer,
      targetLocationId,
    );

    // Tabel ini adalah laporan aktivitas poin. Transaksi tanpa penambahan dan
    // tanpa penggunaan poin tidak memberi nilai pada laporan dan tidak perlu
    // memenuhi penyimpanan. Tetap hapus pasangan lama bila Runchise mengoreksi
    // transaksi yang sebelumnya memiliki poin menjadi nol-nol.
    if (
      data.penambahan_poin === 0 &&
      Number(data.penggunaan_poin) === 0
    ) {
      const deleted = await prisma.customerSalesTransactionReport.deleteMany({
        where: {
          source_location_id: targetLocationId,
          runchise_sales_transaction_id: saleId,
        },
      });
      skippedZeroPoints++;
      deletedZeroPoints += deleted.count;
      continue;
    }

    // Identitas baris adalah pasangan outlet sumber + ID transaksi. Unique
    // index kolom tunggal sudah dihapus migration
    // 20260729120000_use_composite_sales_transaction_identity, jadi upsert
    // harus memakai composite key-nya.
    await prisma.customerSalesTransactionReport.upsert({
      where: {
        source_location_id_runchise_sales_transaction_id: {
          source_location_id: targetLocationId,
          runchise_sales_transaction_id: saleId,
        },
      },
      update: data,
      create: data,
    });

    synced++;
  }

  return {
    synced,
    total: salesTransactions.length,
    skipped,
    skipped_zero_points: skippedZeroPoints,
    deleted_zero_points: deletedZeroPoints,
  };
}

function isCustomerPromoChannel(channel) {
  return CUSTOMER_PROMO_CHANNELS.has(normalizeChannel(channel));
}

// ===================== SYNC PRODUCTS =====================

// Sinkronisasi katalog hanya untuk produk yang kategorinya terhubung ke
// sub-brand Crisbar 1041. Implementasi yang sama dipakai CLI, endpoint admin,
// dan cron agar tidak ada perilaku import yang berbeda.
async function syncProducts() {
  return importCrisbarProducts({ db: prisma, writeEnabled: true });
}

// ===================== SYNC BRANDS =====================

// Sync brand & sub-brand dari Runchise
async function syncBrands() {
  const subBrandsArray = await fetchAllSubBrands();

  if (!subBrandsArray || subBrandsArray.length === 0) {
    console.warn('Tidak ada data sub_brands dari API.');
    return { synced: 0, total: 0 };
  }

  console.log(
    'Sample sub_brand dari API:',
    JSON.stringify(subBrandsArray[0], null, 2),
  );

  let synced = 0;
  const seenParentBrandIds = new Set();
  const localBrandByRunchiseId = new Map();

  for (const sb of subBrandsArray) {
    if (!sb.brand?.id || !sb.brand?.name) {
      console.warn(`Sub_brand id=${sb.id} tidak punya data brand, dilewati.`);
      continue;
    }

    const parentBrandId = sb.brand.id;
    const parentBrandName = sb.brand.name;

    let localBrand = localBrandByRunchiseId.get(parentBrandId);

    if (!localBrand) {
      try {
        try {
          await prisma.brand.updateMany({
            where: { id: parentBrandId, runchise_id: null },
            data: {
              runchise_id: parentBrandId,
              name: parentBrandName || `Brand ${parentBrandId}`,
            },
          });
        } catch (error) {
          if (error.code !== 'P2002') throw error;
        }

        localBrand = await prisma.brand.upsert({
          where: { runchise_id: parentBrandId },
          update: {
            name: parentBrandName || `Brand ${parentBrandId}`,
          },
          create: {
            runchise_id: parentBrandId,
            name: parentBrandName || `Brand ${parentBrandId}`,
          },
        });

        localBrandByRunchiseId.set(parentBrandId, localBrand);

        if (!seenParentBrandIds.has(parentBrandId)) {
          seenParentBrandIds.add(parentBrandId);
          console.log(
            `Parent brand synced: runchise_id=${parentBrandId}, name=${localBrand.name}`,
          );
        }
      } catch (error) {
        console.error(
          `Gagal upsert parent brand runchise_id=${parentBrandId}:`,
          error.message,
        );
        continue;
      }
    }

    // 2. Upsert sub_brand
    try {
      const subBrand = await prisma.subBrand.upsert({
        where: { runchise_id: sb.id },
        update: {
          name: sb.name,
          image_url: sb.image_url || null,
          location_type: sb.location_type || null,
          is_select_all_location: sb.is_select_all_location ?? false,
          enable_online_order: sb.enable_online_order ?? true,
          brand_id: localBrand.id,
        },
        create: {
          runchise_id: sb.id,
          brand_id: localBrand.id,
          name: sb.name,
          image_url: sb.image_url || null,
          location_type: sb.location_type || null,
          is_select_all_location: sb.is_select_all_location ?? false,
          enable_online_order: sb.enable_online_order ?? true,
        },
      });

      const categoryIds = [];

      for (const category of sb.product_categories ?? []) {
        if (category.id == null) continue;

        await prisma.menuCategory.upsert({
          where: { id: category.id },
          update: {
            name: category.name,
          },
          create: {
            id: category.id,
            brand_id: localBrand.id,
            name: category.name,
          },
        });

        await prisma.subBrandProductCategory.upsert({
          where: {
            sub_brand_id_menu_category_id: {
              sub_brand_id: subBrand.id,
              menu_category_id: category.id,
            },
          },
          update: {},
          create: {
            sub_brand_id: subBrand.id,
            menu_category_id: category.id,
          },
        });

        categoryIds.push(category.id);
      }

      await prisma.subBrandProductCategory.deleteMany({
        where: {
          sub_brand_id: subBrand.id,
          menu_category_id: { notIn: categoryIds },
        },
      });

      synced++;
      console.log(`Sub_brand synced: runchise_id=${sb.id}, name=${sb.name}`);
    } catch (error) {
      console.error(`Gagal menyimpan sub_brand id=${sb.id}:`, error.message);
    }
  }

  return { synced, total: subBrandsArray.length };
}

// ===================== SYNC LOCATIONS =====================

// Sync lokasi outlet dari Runchise
async function syncLocations(brandId = 1) {
  const locations = await fetchAllLocations();

  let synced = 0;

  for (const loc of locations) {
    const runchiseLocationId = Number(loc.id);
    if (!Number.isInteger(runchiseLocationId) || runchiseLocationId <= 0) {
      continue;
    }

    // Pastikan brand ada dulu
    await prisma.brand.upsert({
      where: { id: brandId },
      update: {},
      create: { id: brandId, name: `Brand ${brandId}` },
    });

    const data = mapRunchiseLocationToLocalData(loc, brandId);
    const existing = await prisma.location.findFirst({
      where: {
        OR: [
          { runchise_id: runchiseLocationId },
          { id: runchiseLocationId },
          { name: { equals: loc.name, mode: 'insensitive' } },
        ],
      },
    });

    if (existing) {
      await prisma.location.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await prisma.location.create({
        data: {
          id: runchiseLocationId,
          ...data,
        },
      });
    }

    synced++;
  }

  return { synced, total: locations.length };
}

async function ensureLocalLocationRunchiseMapping(localLocationId, brandId = 1) {
  if (!localLocationId) return null;

  const localLocation = await prisma.location.findUnique({
    where: { id: Number(localLocationId) },
  });

  if (!localLocation) return null;
  if (localLocation.runchise_id) return localLocation;

  const locations = await fetchAllLocations();
  const normalizedLocalName = normalizeLocationName(localLocation.name);
  const matchedLocation = locations.find((loc) => {
    const runchiseLocationId = Number(loc.id);

    return (
      runchiseLocationId === localLocation.id ||
      normalizeLocationName(loc.name) === normalizedLocalName
    );
  });

  if (!matchedLocation) return localLocation;

  const data = mapRunchiseLocationToLocalData(matchedLocation, brandId);

  return prisma.location.update({
    where: { id: localLocation.id },
    data,
  });
}

// ===================== SYNC PROMOS =====================

function positiveRunchiseId(value) {
  const parsed = Number(value?.id ?? value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasMatchingId(items, allowedIds) {
  return Array.isArray(items) && items.some((item) => allowedIds.has(positiveRunchiseId(item)));
}

async function loadCrisbarPromoContext() {
  const subBrand = await prisma.subBrand.findUnique({
    where: { runchise_id: TARGET_PROMO_SUB_BRAND_RUNCHISE_ID },
    select: {
      name: true,
      brand: { select: { runchise_id: true } },
      product_categories: { select: { menu_category_id: true } },
    },
  });

  if (!subBrand) {
    throw new Error(`Sub-brand Crisbar ${TARGET_PROMO_SUB_BRAND_RUNCHISE_ID} tidak ditemukan`);
  }
  if (subBrand.brand.runchise_id !== TARGET_PROMO_PARENT_BRAND_RUNCHISE_ID) {
    throw new Error('Parent brand sub-brand Crisbar tidak sesuai');
  }

  const categoryIds = new Set(
    subBrand.product_categories.map((link) => link.menu_category_id),
  );
  if (categoryIds.size === 0) {
    throw new Error('Mapping kategori sub-brand Crisbar kosong');
  }

  const products = await prisma.menuItem.findMany({
    where: {
      category_id: { in: [...categoryIds] },
      runchise_id: { not: null },
    },
    select: { runchise_id: true },
  });

  return {
    name: subBrand.name,
    categoryIds,
    productIds: new Set(products.map((product) => product.runchise_id)),
  };
}

function getCrisbarPromoEvidence(promo, context) {
  if (
    hasMatchingId(promo?.sub_brands, TARGET_PROMO_SUB_BRAND_IDS)
  ) {
    return 'sub_brand';
  }

  const rule = promo?.promo_rule ?? {};
  const reward = promo?.promo_reward ?? {};
  const categoryLists = [
    rule.product_categories,
    rule.required_purchase_product_categories,
    rule.maximum_qty_applied_to_product_categories,
    reward.get_product_categories,
  ];
  if (categoryLists.some((items) => hasMatchingId(items, context.categoryIds))) {
    return 'category';
  }

  const productLists = [
    rule.products,
    rule.required_purchase_products,
    rule.maximum_qty_applied_to_products,
    reward.get_products,
    reward.get_reward_products,
  ];
  if (productLists.some((items) => hasMatchingId(items, context.productIds))) {
    return 'product';
  }

  return null;
}

function mapRunchisePromoToLocalData(promo, context, now) {
  const runchiseId = Number(promo?.id);
  const name = String(promo?.name ?? '').trim();
  if (!Number.isInteger(runchiseId) || runchiseId <= 0 || !name) {
    throw new Error(`Promo Runchise tidak valid: id=${promo?.id ?? 'null'}`);
  }

  const status = getEffectivePromoStatus(promo, now);
  const posChannel = isPosChannel(promo.channel);
  const discountAmount = promo.promo_reward?.discount_amount;
  const parsedDiscount = discountAmount == null ? null : Number(discountAmount);

  if (parsedDiscount !== null && !Number.isFinite(parsedDiscount)) {
    throw new Error(`Nilai diskon promo ${runchiseId} tidak valid`);
  }

  return {
    runchise_id: runchiseId,
    name,
    status,
    start_date: promo.start_date ?? null,
    end_date: promo.end_date ?? null,
    channel: normalizeChannel(promo.channel) || null,
    is_online_only: isOnlineChannel(promo.channel),
    is_all_outlets: promo.is_select_all_location === true,
    locations:
      promo.is_select_all_location === true
        ? []
        : (promo.locations ?? []).map((location) => ({
            id: location.id,
            name: location.name,
          })),
    discount_amount: parsedDiscount,
    discount_is_percentage:
      promo.promo_reward?.discount_is_percentage === true,
    template: promo.promo_reward?.template ?? null,
    sub_brand: context.name,
    is_pos_channel: posChannel,
    is_visible:
      status === 'active' &&
      isCustomerPromoChannel(promo.channel),
    start_at: parseRunchiseDate(promo.start_date, false),
    raw: promo,
  };
}

async function upsertPromoChunk(promos) {
  if (promos.length === 0) return;

  await prisma.$transaction(
    promos.map((promo) =>
      prisma.promo.upsert({
        where: { runchise_id: promo.runchise_id },
        update: promo,
        create: promo,
      }),
    ),
  );
}

async function syncPromos() {
  const context = await loadCrisbarPromoContext();
  const now = new Date();
  const scannedPromoIds = new Set();
  const matchedPromoIds = new Set();
  let reportedTotal = null;
  let pagesProcessed = 0;
  let visible = 0;
  const evidenceCounts = { sub_brand: 0, category: 0, product: 0 };

  for (let page = 1; page <= PROMO_MAX_PAGES; page++) {
    const data = await fetchPromosPage({ page, itemPerPage: PROMO_PAGE_SIZE });
    const pageTotal = Number(data.paging.total_item);
    if (Number.isFinite(pageTotal)) {
      if (reportedTotal === null) reportedTotal = pageTotal;
      if (reportedTotal !== pageTotal) {
        throw new Error(`total_item promo berubah: ${reportedTotal} -> ${pageTotal}`);
      }
    }

    const mappedPromos = [];
    for (const rawPromo of data.promos) {
      const promoId = positiveRunchiseId(rawPromo?.id);
      if (!promoId) throw new Error(`Promo Runchise tidak valid: id=${rawPromo?.id ?? 'null'}`);
      if (scannedPromoIds.has(promoId)) {
        throw new Error(`Promo duplikat antar halaman: ${promoId}`);
      }
      scannedPromoIds.add(promoId);

      const evidence = getCrisbarPromoEvidence(rawPromo, context);
      if (!evidence) continue;

      const promo = mapRunchisePromoToLocalData(rawPromo, context, now);
      mappedPromos.push(promo);
      matchedPromoIds.add(promo.runchise_id);
      evidenceCounts[evidence]++;
      if (promo.is_visible) visible++;
    }

    for (let offset = 0; offset < mappedPromos.length; offset += PROMO_WRITE_CHUNK_SIZE) {
      await upsertPromoChunk(mappedPromos.slice(offset, offset + PROMO_WRITE_CHUNK_SIZE));
    }

    pagesProcessed++;
    console.log(
      `Promo halaman ${page}: API=${data.promos.length}, Crisbar=${mappedPromos.length}, total Crisbar=${matchedPromoIds.size}`,
    );

    if (data.paging.next_page === null || data.promos.length === 0) break;
    if (page === PROMO_MAX_PAGES) {
      throw new Error(`Pagination promo melebihi ${PROMO_MAX_PAGES} halaman`);
    }
  }

  if (scannedPromoIds.size === 0) {
    throw new Error('API tidak menghasilkan promo; rekonsiliasi dibatalkan');
  }
  if (reportedTotal !== null && scannedPromoIds.size !== reportedTotal) {
    throw new Error(`Pagination promo tidak lengkap: ${scannedPromoIds.size}/${reportedTotal}`);
  }
  if (matchedPromoIds.size === 0) {
    throw new Error('Tidak ada promo dengan bukti eksplisit Crisbar; pembersihan dibatalkan');
  }

  const removed = await prisma.promo.deleteMany({
    where: {
      runchise_id: { notIn: [...matchedPromoIds] },
    },
  });

  return {
    api_scanned: scannedPromoIds.size,
    synced: matchedPromoIds.size,
    total: matchedPromoIds.size,
    pages_processed: pagesProcessed,
    visible_for_customer: visible,
    rejected_non_crisbar_or_ambiguous: scannedPromoIds.size - matchedPromoIds.size,
    removed_from_local_cache: removed.count,
    matched_by: evidenceCounts,
  };
}

module.exports = {
  syncCustomers,
  upsertRunchiseCustomer,
  syncProducts,
  syncCustomerPoints,
  syncCustomerPointsFromStaging,
  inspectCustomerPointSources,
  syncSalesTransactionReports,
  syncBrands,
  syncLocations,
  ensureLocalLocationRunchiseMapping,
  getCrisbarPromoEvidence,
  loadCrisbarPromoContext,
  mapRunchisePromoToLocalData,
  syncPromos,
};
