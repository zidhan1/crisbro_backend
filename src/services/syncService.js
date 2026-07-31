// Mengimpor Prisma untuk akses database lokal
const prisma = require('../lib/prisma');

// Prisma.sql/Prisma.join dipakai untuk menyusun bulk upsert yang aman parameter
const { Prisma } = require('@prisma/client');

// Mengimpor service Runchise (API eksternal)
const {
  fetchAllCustomers,
  fetchAllCustomersAcrossLocations,
  fetchAllSalesTransactions,
  fetchAllProducts,
  fetchAllSubBrands,
  fetchAllLocations,
  fetchAllPromos,
} = require('./runchiseService');
const { getSubBrandMapping } = require('./subBrandService');

// Mengimpor konfigurasi menu redeem Crisbro
const {
  CRISBRO_REDEEM_MENU_CATEGORY_NAME,
  CRISBRO_REDEEM_ITEM_CATEGORIES,
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
} = require('../constants/crisbroRedeemMenu');

const VISIBLE_PROMO_SUB_BRANDS = new Set(['Crisbar']);
const DEFAULT_PROMO_LIFESPAN_DAYS = 90;
const POS_CHANNEL = 'pos';

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

function detectPromoSubBrand(promo, categoryIdToSubBrand) {
  const rule = promo.promo_rule;
  if (!rule) return 'Crisbar';

  for (const category of rule.product_categories ?? []) {
    const subBrand = categoryIdToSubBrand.get(category.id);
    if (subBrand) return subBrand;
  }

  const productNames = [
    ...(rule.products ?? []).map((product) => product.name),
    ...(promo.promo_reward?.get_products ?? []).map((product) => product.name),
  ];
  const lowerNames = productNames.map((name) => name.toLowerCase());

  if (
    lowerNames.some(
      (name) => name.includes('jeong bok') || name.includes('bokki'),
    )
  ) {
    return 'Jeong Bok Chicken';
  }
  if (
    lowerNames.some((name) => name.includes('jaya') || name.includes('sambal'))
  ) {
    return 'Green Jaya';
  }
  if (lowerNames.some((name) => name.includes('warkop'))) {
    return 'Warkop CBR';
  }

  return 'Crisbar';
}

// ===================== SYNC CUSTOMERS =====================

// Sync customer dari Runchise → database lokal
// locationId hanya menjadi cadangan owner_location_id ketika Runchise tidak
// mengirimkannya. Default lama 1 membuat customer tanpa outlet dipetakan ke
// outlet yang tidak ada, sekaligus membuat baris Location id 1 palsu.
async function syncCustomers(locationId = null) {
  const customers = await fetchAllCustomersAcrossLocations();
  const fallbackLocationId = parseRunchiseId(locationId);
  let synced = 0;
  let skippedConflicts = 0;

  for (const c of customers) {
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
      skippedConflicts++;
      console.warn(
        `Sync customer skipped: phone=${normalizedPhone} sudah dipakai user_id=${existingUserByPhone.id} role=${existingUserByPhone.role} yang tidak cocok dengan customer Runchise.`,
      );
      continue;
    }

    if (
      existingByRunchiseId &&
      existingByPhone &&
      existingByRunchiseId.id !== existingByPhone.id
    ) {
      skippedConflicts++;
      console.warn(
        `Sync customer skipped: runchise_id=${c.id} cocok dengan customer_id=${existingByRunchiseId.id}, tetapi phone cocok dengan customer_id=${existingByPhone.id}.`,
      );
      continue;
    }

    if (
      existingByPhone &&
      existingByPhone.runchise_id !== null &&
      existingByPhone.runchise_id !== c.id
    ) {
      skippedConflicts++;
      console.warn(
        `Sync customer skipped: phone=${normalizedPhone} sudah terhubung ke runchise_id=${existingByPhone.runchise_id}, bukan ${c.id}.`,
      );
      continue;
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
    } else {
      await prisma.user.create({
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
      });
    }
    synced++;
  }

  return {
    synced,
    total: customers.length,
    skipped_conflicts: skippedConflicts,
  };
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

// ===================== SYNC PRODUCTS =====================

// Sync product dari Runchise → menuItem lokal
async function syncProducts(brandId = 1, products = null) {
  const productList = products || (await fetchAllProducts());
  let synced = 0;

  for (const p of productList) {
    // Pastikan category ada, atau buat baru jika belum ada
    let category;
    if (p.product_category?.id) {
      category = await prisma.menuCategory.upsert({
        where: { id: p.product_category.id },
        update: { name: p.product_category.name },
        create: {
          id: p.product_category.id,
          brand_id: brandId,
          name: p.product_category.name,
        },
      });
    } else {
      // Produk tanpa kategori → masuk ke "Uncategorized"
      category = await prisma.menuCategory.upsert({
        where: { id: 9999 },
        update: {},
        create: { id: 9999, brand_id: brandId, name: 'Uncategorized' },
      });
    }

    // Upsert menu item
    await prisma.menuItem.upsert({
      where: { runchise_id: p.id },
      update: {
        name: p.name,
        description: p.description ?? null,
        price: parseFloat(p.sell_price),
        image_url: p.image_url || null,
        is_active: p.status === 'activated',
        category_id: category.id,
      },
      create: {
        runchise_id: p.id,
        brand_id: brandId,
        category_id: category.id,
        name: p.name,
        description: p.description ?? null,
        price: parseFloat(p.sell_price),
        image_url: p.image_url || null,
        is_active: p.status === 'activated',
      },
    });
    synced++;
  }

  return { synced, total: productList.length };
}

// ===================== SYNC FIND OR CREATE CATEGORY =====================

async function findOrCreateMenuCategory({ brandId, name, sortOrder }) {
  const existing = await prisma.menuCategory.findFirst({
    where: { brand_id: brandId, name },
  });

  if (existing) {
    return prisma.menuCategory.update({
      where: { id: existing.id },
      data: {
        sort_order: sortOrder,
        is_active: true,
      },
    });
  }

  return prisma.menuCategory.create({
    data: {
      brand_id: brandId,
      name,
      sort_order: sortOrder,
      is_active: true,
    },
  });
}

// ===================== SYNC CRISBRO REDEEM MENU =====================

// Sync menu redeem khusus Crisbro dari Runchise → database lokal
async function syncCrisbroRedeemMenu(brandId = 1, products = null) {
  // Pastikan brand ada
  await prisma.brand.upsert({
    where: { id: brandId },
    update: {},
    create: { id: brandId, name: `Brand ${brandId}` },
  });

  const productList = products || (await fetchAllProducts());
  const menuLookup = buildCrisbroRedeemMenuLookup();
  const categoriesByName = new Map();

  // Buat kategori utama redeem
  const menuCrisbroCategory = await findOrCreateMenuCategory({
    brandId,
    name: CRISBRO_REDEEM_MENU_CATEGORY_NAME,
    sortOrder: 0,
  });

  categoriesByName.set(CRISBRO_REDEEM_MENU_CATEGORY_NAME, menuCrisbroCategory);

  // Buat kategori dari config redeem
  for (const [index, category] of CRISBRO_REDEEM_ITEM_CATEGORIES.entries()) {
    const localCategory = await findOrCreateMenuCategory({
      brandId,
      name: category.name,
      sortOrder: index + 1,
    });

    categoriesByName.set(category.name, localCategory);
  }

  const seenMenuNames = new Set();
  const syncedRunchiseIds = [];
  const duplicateNames = [];
  const syncedMenuCrisbroNames = [];
  let synced = 0;

  for (const product of productList) {
    const normalizedProductName = normalizeMenuName(product.name);
    const normalizedProductCategory = normalizeMenuName(
      product.product_category?.name,
    );

    // Jika masuk kategori Crisbro langsung sync
    if (
      normalizedProductCategory ===
      normalizeMenuName(CRISBRO_REDEEM_MENU_CATEGORY_NAME)
    ) {
      const isActive = product.status === 'activated';

      await prisma.menuItem.upsert({
        where: { runchise_id: product.id },
        update: {
          brand_id: brandId,
          category_id: menuCrisbroCategory.id,
          name: product.name,
          description: product.description ?? null,
          price: parseFloat(product.sell_price ?? 0),
          image_url: product.image_url || null,
          is_active: isActive,
        },
        create: {
          runchise_id: product.id,
          brand_id: brandId,
          category_id: menuCrisbroCategory.id,
          name: product.name,
          description: product.description ?? null,
          price: parseFloat(product.sell_price ?? 0),
          image_url: product.image_url || null,
          is_active: isActive,
        },
      });

      syncedRunchiseIds.push(product.id);
      syncedMenuCrisbroNames.push(product.name);
      synced++;
      continue;
    }

    // Cek apakah termasuk whitelist redeem menu
    const menuConfig = menuLookup.get(normalizedProductName);

    if (!menuConfig) continue;

    if (seenMenuNames.has(normalizedProductName)) {
      duplicateNames.push(product.name);
      continue;
    }

    seenMenuNames.add(normalizedProductName);

    const category = categoriesByName.get(menuConfig.categoryName);
    const isActive = product.status === 'activated';

    await prisma.menuItem.upsert({
      where: { runchise_id: product.id },
      update: {
        brand_id: brandId,
        category_id: category.id,
        name: product.name,
        description: product.description ?? null,
        price: parseFloat(product.sell_price ?? 0),
        image_url: product.image_url || null,
        is_active: isActive,
      },
      create: {
        runchise_id: product.id,
        brand_id: brandId,
        category_id: category.id,
        name: product.name,
        description: product.description ?? null,
        price: parseFloat(product.sell_price ?? 0),
        image_url: product.image_url || null,
        is_active: isActive,
      },
    });

    syncedRunchiseIds.push(product.id);
    synced++;
  }

  const missingMenuNames = Array.from(menuLookup.entries())
    .filter(([menuName]) => !seenMenuNames.has(menuName))
    .map(([, menuConfig]) => menuConfig.displayName);
  const expectedMenuNames = new Set(menuLookup.keys());

  const categoryIds = Array.from(categoriesByName.values()).map(
    (category) => category.id,
  );

  const localRedeemItems = await prisma.menuItem.findMany({
    where: {
      brand_id: brandId,
      category_id: { in: categoryIds },
    },
    select: { id: true, name: true, runchise_id: true },
  });

  const staleItemIds = localRedeemItems
    .filter((item) => {
      const isWhitelisted = expectedMenuNames.has(normalizeMenuName(item.name));
      const isMenuCrisbroItem =
        item.category_id === menuCrisbroCategory.id &&
        syncedMenuCrisbroNames
          .map((name) => normalizeMenuName(name))
          .includes(normalizeMenuName(item.name));
      const wasSynced = syncedRunchiseIds.includes(item.runchise_id);

      return !(isWhitelisted || isMenuCrisbroItem) || !wasSynced;
    })
    .map((item) => item.id);

  if (staleItemIds.length > 0) {
    await prisma.menuItem.updateMany({
      where: { id: { in: staleItemIds } },
      data: { is_active: false },
    });
  }

  return {
    synced,
    total_runchise_products: productList.length,
    missing: missingMenuNames,
    duplicate_names_skipped: duplicateNames,
    deactivated_stale_items: staleItemIds.length,
  };
}

async function syncProductsAndRedeemMenu(brandId = 1) {
  const products = await fetchAllProducts();

  return {
    products: await syncProducts(brandId, products),
    redeemMenu: await syncCrisbroRedeemMenu(brandId, products),
  };
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

async function syncPromos() {
  const [promos, { categoryIdToSubBrand }] = await Promise.all([
    fetchAllPromos(),
    getSubBrandMapping(),
  ]);
  const now = new Date();
  const syncedPromoIds = [];
  let synced = 0;

  for (const promo of promos) {
    const status = getEffectivePromoStatus(promo, now);
    const subBrand = detectPromoSubBrand(promo, categoryIdToSubBrand);
    const posChannel = isPosChannel(promo.channel);
    const isVisible =
      status !== 'completed' &&
      status !== 'inactive' &&
      VISIBLE_PROMO_SUB_BRANDS.has(subBrand) &&
      !posChannel;
    const startAt = parseRunchiseDate(promo.start_date, false);

    await prisma.promo.upsert({
      where: { runchise_id: promo.id },
      update: {
        name: promo.name,
        status,
        start_date: promo.start_date ?? null,
        end_date: promo.end_date ?? null,
        channel: promo.channel ?? null,
        is_online_only: isOnlineChannel(promo.channel),
        is_all_outlets: promo.is_select_all_location === true,
        locations:
          promo.is_select_all_location === true
            ? []
            : (promo.locations ?? []).map((location) => ({
                id: location.id,
                name: location.name,
              })),
        discount_amount: promo.promo_reward?.discount_amount
          ? parseFloat(promo.promo_reward.discount_amount)
          : null,
        discount_is_percentage:
          promo.promo_reward?.discount_is_percentage ?? false,
        template: promo.promo_reward?.template ?? null,
        sub_brand: subBrand,
        is_pos_channel: posChannel,
        is_visible: isVisible,
        start_at: startAt,
        raw: promo,
      },
      create: {
        runchise_id: promo.id,
        name: promo.name,
        status,
        start_date: promo.start_date ?? null,
        end_date: promo.end_date ?? null,
        channel: promo.channel ?? null,
        is_online_only: isOnlineChannel(promo.channel),
        is_all_outlets: promo.is_select_all_location === true,
        locations:
          promo.is_select_all_location === true
            ? []
            : (promo.locations ?? []).map((location) => ({
                id: location.id,
                name: location.name,
              })),
        discount_amount: promo.promo_reward?.discount_amount
          ? parseFloat(promo.promo_reward.discount_amount)
          : null,
        discount_is_percentage:
          promo.promo_reward?.discount_is_percentage ?? false,
        template: promo.promo_reward?.template ?? null,
        sub_brand: subBrand,
        is_pos_channel: posChannel,
        is_visible: isVisible,
        start_at: startAt,
        raw: promo,
      },
    });

    syncedPromoIds.push(promo.id);
    synced++;
  }

  await prisma.promo.updateMany({
    where: {
      runchise_id: { notIn: syncedPromoIds },
    },
    data: { is_visible: false },
  });

  return { synced, total: promos.length };
}

module.exports = {
  syncCustomers,
  syncProducts,
  syncProductsAndRedeemMenu,
  syncCrisbroRedeemMenu,
  syncCustomerPoints,
  syncCustomerPointsFromStaging,
  inspectCustomerPointSources,
  syncSalesTransactionReports,
  syncBrands,
  syncLocations,
  ensureLocalLocationRunchiseMapping,
  syncPromos,
};
