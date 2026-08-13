// Mengimpor Prisma untuk akses database lokal
const prisma = require('../lib/prisma');
const { syncSalesAcrossLocations } = require('../lib/salesTransactionSyncCoverage');

// Prisma.sql/Prisma.join dipakai untuk menyusun bulk upsert yang aman parameter
const { Prisma } = require('@prisma/client');

function isUniqueConstraintError(error) {
  return error?.code === 'P2002';
}

// Mengimpor service Runchise (API eksternal)
const {
  iterateSalesTransactionPages,
  fetchAllSubBrands,
  fetchAllLocations,
  fetchCustomersPage,
  fetchPromosPage,
  assertPageWithinLimit,
} = require('./runchiseService');
const {
  importProducts: importCrisbarProducts,
} = require('../../scripts/importSelectedCrisbarProducts');
const {
  normalizePhone,
  phoneVariants,
} = require('../lib/phoneNumber');

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

// Ukuran batch bulk upsert diatur untuk menyeimbangkan efisiensi query dan performa database.
const CUSTOMER_POINT_UPSERT_CHUNK = 500;

function normalizeChannel(rawChannel) {
  return String(rawChannel ?? '')
    .trim()
    .toLowerCase();
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

function isPosChannel(channel) {
  return normalizeChannel(channel) === POS_CHANNEL;
}

function isOnlineChannel(channel) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return false;
  return normalized !== POS_CHANNEL;
}

// M-4: Menambahkan offset `+07:00` saat parsing tanggal agar waktu promo selalu konsisten di semua zona runtime dan mencegah status promo bergeser.
function parseRunchiseDate(value, endOfDay = false) {
  if (!value) return null;

  const parts = String(value).split('/');
  if (parts.length !== 3) return null;

  const [day, month, year] = parts.map(Number);
  if (!day || !month || !year) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const timeOfDay = endOfDay ? '23:59:59.999' : '00:00:00.000';
  const date = new Date(`${year}-${pad(month)}-${pad(day)}T${timeOfDay}+07:00`);

  return Number.isNaN(date.getTime()) ? null : date;
}

// Menggunakan operasi UTC untuk memastikan pergeseran tanggal tetap konsisten di semua zona runtime.
function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
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

// Sinkronisasi customer menggunakan owner_location_id dari Runchise dengan fallback outlet yang valid agar tidak menghasilkan pemetaan lokasi yang keliru.
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

  // Pemrosesan customer dilakukan per halaman dengan deduplikasi ID agar penggunaan memori tetap efisien tanpa kehilangan data lintas outlet.
  const processedCustomerIds = new Set();
  let synced = 0;
  let skippedConflicts = 0;
  let failed = 0;
  let unresolvedLocationMemberships = 0;

  for (const outletId of locationIds) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      // M-2: batasi jumlah halaman per outlet agar next_page yang tidak pernah
      // null (bug upstream/respons tak terduga) tidak membuat loop ini
      // berjalan tanpa henti sampai timeout function, sama seperti fetchAll*
      // di runchiseService.js.
      assertPageWithinLimit('customers', page);
      const data = await fetchCustomersPage(outletId, page);
      const customers = Array.isArray(data.customers) ? data.customers : [];

      // C-2: Customer diproses per batch agar jumlah query berkurang drastis dan sinkronisasi menjadi lebih cepat serta efisien.
      const pageCustomers = [];
      for (const customer of customers) {
        const runchiseId = Number(customer.id);
        if (!Number.isInteger(runchiseId) || runchiseId <= 0) continue;
        if (processedCustomerIds.has(runchiseId)) continue;

        processedCustomerIds.add(runchiseId);
        pageCustomers.push(customer);
      }

      if (pageCustomers.length > 0) {
        const pageResults = await upsertRunchiseCustomersBatch(
          pageCustomers,
          fallbackLocationId,
        );
        for (const result of pageResults) {
          unresolvedLocationMemberships += Array.isArray(
            result?.unresolved_location_ids,
          )
            ? result.unresolved_location_ids.length
            : 0;
          if (result.status === 'skipped_conflict') skippedConflicts++;
          else if (result.status === 'failed') failed++;
          else synced++;
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
    failed,
    unresolved_location_memberships: unresolvedLocationMemberships,
  };
}

function buildLocationResolution(locationRows) {
  const rowsByRunchiseId = new Map();

  for (const row of locationRows) {
    const runchiseId = Number(row.runchise_id);
    if (!Number.isInteger(runchiseId) || runchiseId <= 0) continue;

    const rows = rowsByRunchiseId.get(runchiseId) ?? [];
    rows.push(row);
    rowsByRunchiseId.set(runchiseId, rows);
  }

  const localIdByRunchiseId = new Map();
  const ambiguousRunchiseIds = new Set();
  for (const [runchiseId, rows] of rowsByRunchiseId) {
    if (rows.length === 1) localIdByRunchiseId.set(runchiseId, rows[0].id);
    else ambiguousRunchiseIds.add(runchiseId);
  }

  return { localIdByRunchiseId, ambiguousRunchiseIds };
}

async function resolveCustomerLocationMemberships(runchiseLocationIds) {
  const uniqueIds = [
    ...new Set(
      runchiseLocationIds
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (uniqueIds.length === 0) {
    return {
      localIdByRunchiseId: new Map(),
      ambiguousRunchiseIds: new Set(),
    };
  }

  const locationRows = await prisma.location.findMany({
    where: { runchise_id: { in: uniqueIds } },
    select: { id: true, runchise_id: true },
  });

  return buildLocationResolution(locationRows);
}

async function updateRunchiseCustomer(existing, payload, uniqueLocationIds) {
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
  if (uniqueLocationIds.length > 0) {
    operations.push(
      prisma.customerLocation.createMany({
        data: uniqueLocationIds.map((location_id) => ({
          customer_id: existing.id,
          location_id,
        })),
        skipDuplicates: true,
      }),
    );
  }
  await prisma.$transaction(operations);
}

async function findCustomerAfterCreateConflict(c, phoneNumberVariants) {
  const [customer, user] = await Promise.all([
    prisma.customer.findFirst({
      where: {
        OR: [
          { runchise_id: Number(c.id) },
          ...(phoneNumberVariants.length > 0
            ? [
                { phone_number: { in: phoneNumberVariants } },
                { user: { phone_number: { in: phoneNumberVariants } } },
              ]
            : []),
        ],
      },
      include: {
        user: { select: { id: true, phone_number: true, role: true } },
      },
    }),
    phoneNumberVariants.length > 0
      ? prisma.user.findFirst({
          where: { phone_number: { in: phoneNumberVariants } },
          include: { customer: true },
        })
      : null,
  ]);
  return { customer, user };
}

// Upsert customer dari Runchise ke database lokal yang digunakan oleh impor penuh maupun worker bertahap agar tetap sesuai batas serverless.
async function upsertRunchiseCustomer(c, fallbackLocationId = null) {
  // Pastikan brand sudah ada di database
  await prisma.brand.upsert({
    where: { id: c.brand_id },
    update: {},
    create: { id: c.brand_id, name: `Brand ${c.brand_id}` },
  });

  const ownerLocationId = Number(c.owner_location_id) || fallbackLocationId;
  const runchiseLocationIds = [
    ...new Set([
      ...(c.location_ids ?? []),
      ...(ownerLocationId ? [ownerLocationId] : []),
    ].map(Number).filter((id) => Number.isInteger(id) && id > 0)),
  ];
  const { localIdByRunchiseId, ambiguousRunchiseIds } =
    await resolveCustomerLocationMemberships(runchiseLocationIds);
  const locationIds = runchiseLocationIds
    .map((runchiseId) => localIdByRunchiseId.get(runchiseId))
    .filter((id) => id !== undefined);
  const uniqueLocationIds = [...new Set(locationIds)];
  const unresolvedLocationIds = runchiseLocationIds.filter(
    (runchiseId) => !localIdByRunchiseId.has(runchiseId),
  );
  const ownerLocalLocationId =
    localIdByRunchiseId.get(ownerLocationId) ?? null;

  if (unresolvedLocationIds.length > 0) {
    console.warn(
      `Sync customer runchise_id=${c.id}: membership lokasi belum dapat dipetakan: ${unresolvedLocationIds.join(', ')}${unresolvedLocationIds.some((id) => ambiguousRunchiseIds.has(id)) ? ' (termasuk mapping ambigu)' : ''}`,
    );
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
    owner_location_id: ownerLocalLocationId,
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

  // Pemeriksaan di atas hanya untuk rekonsiliasi data yang sudah ada. Constraint
  // unik database tetap menjadi sumber kebenaran ketika dua run berjalan serentak.
  if (existing) {
    await updateRunchiseCustomer(existing, payload, uniqueLocationIds);

    return {
      status: 'updated',
      customer_id: existing.id,
      unresolved_location_ids: unresolvedLocationIds,
    };
  }

  let createdUser;
  try {
    createdUser = await prisma.user.create({
      data: {
        phone_number: normalizedPhone,
        password_hash: '',
        activation_status: 'pending_activation',
        role: 'customer',
        customer: {
          create: {
            ...payload,
            ...(uniqueLocationIds.length > 0 && {
              customer_locations: {
                create: uniqueLocationIds.map((location_id) => ({ location_id })),
              },
            }),
          },
        },
      },
      include: { customer: { select: { id: true } } },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    // P2002 berarti run lain memenangkan INSERT pada unique phone/runchise_id.
    // Ambil pemenang lalu jalankan rekonsiliasi yang sama; tidak membuat baris baru.
    const winner = await findCustomerAfterCreateConflict(c, phoneNumberVariants);
    const winnerCustomer = winner.customer || winner.user?.customer;
    if (winner.user && !winner.user.customer) {
      return { status: 'skipped_conflict', reason: 'phone_used_by_other_user' };
    }
    if (!winnerCustomer) throw error;
    if (
      winnerCustomer.runchise_id !== null &&
      winnerCustomer.runchise_id !== Number(c.id)
    ) {
      return {
        status: 'skipped_conflict',
        reason: 'phone_linked_to_other_runchise_id',
      };
    }
    await updateRunchiseCustomer(winnerCustomer, payload, uniqueLocationIds);
    return {
      status: 'updated_after_conflict',
      customer_id: winnerCustomer.id,
      unresolved_location_ids: unresolvedLocationIds,
    };
  }

  return {
    status: 'created',
    customer_id: createdUser.customer?.id ?? null,
    unresolved_location_ids: unresolvedLocationIds,
  };
}

// C-2: Customer diproses dengan batch upsert untuk mengurangi round-trip database, menjaga konsistensi data, dan meningkatkan efisiensi pada lingkungan serverless.
async function upsertRunchiseCustomersBatch(customersInput, fallbackLocationId = null) {
  const results = new Array(customersInput.length).fill(null);

  // ---- 1. Bangun kandidat di memori (tanpa query DB) ----
  const candidates = customersInput.map((c, index) => {
    const runchiseId = Number(c.id);
    if (!Number.isInteger(runchiseId) || runchiseId <= 0) {
      return { index, valid: false };
    }

    const ownerLocationId = Number(c.owner_location_id) || fallbackLocationId;
    const runchiseLocationIds = [
      ...new Set(
        [
          ...(c.location_ids ?? []),
          ...(ownerLocationId ? [ownerLocationId] : []),
        ]
          .map(Number)
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];

    const normalizedPhone = normalizePhone(c.phone_number);
    const phoneNumberVariants = phoneVariants(normalizedPhone);
    const syncedAt = new Date();

    const payload = {
      runchise_id: runchiseId,
      runchise_location_id: ownerLocationId,
      runchise_sync_status: 'synced',
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
      owner_location_id: null,
    };

    return {
      index,
      valid: true,
      runchiseId,
      brandId: c.brand_id,
      ownerLocationId,
      runchiseLocationIds,
      normalizedPhone,
      createPhone: normalizedPhone || `__runchise_sync_${runchiseId}`,
      phoneNumberVariants,
      payload,
    };
  });

  const validCandidates = [];
  for (const candidate of candidates) {
    if (candidate.valid) {
      validCandidates.push(candidate);
    } else {
      results[candidate.index] = { status: 'failed', reason: 'invalid_runchise_id' };
    }
  }

  if (validCandidates.length === 0) return results;

  // Membership customer hanya boleh menunjuk Location master yang sudah
  // disinkronkan. ID dari API adalah runchise_id, bukan primary key lokal.
  const requestedLocationIds = [
    ...new Set(validCandidates.flatMap((c) => c.runchiseLocationIds)),
  ];
  const { localIdByRunchiseId, ambiguousRunchiseIds } =
    await resolveCustomerLocationMemberships(requestedLocationIds);
  for (const candidate of validCandidates) {
    candidate.locationIds = [
      ...new Set(
        candidate.runchiseLocationIds
          .map((runchiseId) => localIdByRunchiseId.get(runchiseId))
          .filter((id) => id !== undefined),
      ),
    ];
    candidate.unresolvedLocationIds = candidate.runchiseLocationIds.filter(
      (runchiseId) => !localIdByRunchiseId.has(runchiseId),
    );
    candidate.payload.owner_location_id =
      localIdByRunchiseId.get(candidate.ownerLocationId) ?? null;

    if (candidate.unresolvedLocationIds.length > 0) {
      console.warn(
        `Sync customer runchise_id=${candidate.runchiseId}: membership lokasi belum dapat dipetakan: ${candidate.unresolvedLocationIds.join(', ')}${candidate.unresolvedLocationIds.some((id) => ambiguousRunchiseIds.has(id)) ? ' (termasuk mapping ambigu)' : ''}`,
      );
    }
  }

  // ---- 2. Preload kecocokan customer: 3 query total, bukan sampai 3 x N ----
  const runchiseIds = validCandidates.map((c) => c.runchiseId);
  const allVariants = [
    ...new Set(validCandidates.flatMap((c) => c.phoneNumberVariants)),
  ];

  const [byRunchiseIdRows, byCustomerPhoneRows, byUserPhoneRows] = await Promise.all([
    prisma.customer.findMany({
      where: { runchise_id: { in: runchiseIds } },
      include: { user: { select: { id: true, phone_number: true, role: true } } },
    }),
    allVariants.length > 0
      ? prisma.customer.findMany({
          where: {
            OR: [
              { phone_number: { in: allVariants } },
              { user: { phone_number: { in: allVariants } } },
            ],
          },
          include: { user: { select: { id: true, phone_number: true, role: true } } },
        })
      : Promise.resolve([]),
    allVariants.length > 0
      ? prisma.user.findMany({
          where: { phone_number: { in: allVariants } },
          include: { customer: true },
        })
      : Promise.resolve([]),
  ]);

  const byRunchiseId = new Map(byRunchiseIdRows.map((r) => [r.runchise_id, r]));
  const customerByPhoneValue = new Map();
  for (const row of byCustomerPhoneRows) {
    if (row.phone_number) customerByPhoneValue.set(row.phone_number, row);
    if (row.user?.phone_number) customerByPhoneValue.set(row.user.phone_number, row);
  }
  const userByPhoneValue = new Map();
  for (const row of byUserPhoneRows) {
    if (row.phone_number) userByPhoneValue.set(row.phone_number, row);
  }
  const findByVariants = (map, variants) => {
    for (const variant of variants) {
      const hit = map.get(variant);
      if (hit) return hit;
    }
    return null;
  };

  // ---- 3. Deteksi konflik & pisahkan jadi toUpdate / toCreate ----
  const toUpdate = [];
  const toCreate = [];
  const seenExistingIds = new Set();

  for (const candidate of validCandidates) {
    const existingByRunchiseId = byRunchiseId.get(candidate.runchiseId) || null;
    const existingCustomerByPhone = findByVariants(
      customerByPhoneValue,
      candidate.phoneNumberVariants,
    );
    const existingUserByPhone = findByVariants(
      userByPhoneValue,
      candidate.phoneNumberVariants,
    );
    const existingByPhone =
      existingCustomerByPhone || existingUserByPhone?.customer || null;

    if (
      existingUserByPhone &&
      (!existingUserByPhone.customer ||
        existingUserByPhone.customer.id !== existingByPhone?.id)
    ) {
      results[candidate.index] = {
        status: 'skipped_conflict',
        reason: 'phone_used_by_other_user',
      };
      continue;
    }

    if (
      existingByRunchiseId &&
      existingByPhone &&
      existingByRunchiseId.id !== existingByPhone.id
    ) {
      results[candidate.index] = {
        status: 'skipped_conflict',
        reason: 'runchise_id_phone_mismatch',
      };
      continue;
    }

    if (
      existingByPhone &&
      existingByPhone.runchise_id !== null &&
      existingByPhone.runchise_id !== candidate.runchiseId
    ) {
      results[candidate.index] = {
        status: 'skipped_conflict',
        reason: 'phone_linked_to_other_runchise_id',
      };
      continue;
    }

    const existing = existingByRunchiseId || existingByPhone;
    if (existing) {
      if (seenExistingIds.has(existing.id)) {
        results[candidate.index] = {
          status: 'skipped_conflict',
          reason: 'duplicate_customer_in_batch',
        };
        continue;
      }
      seenExistingIds.add(existing.id);
      toUpdate.push({ candidate, existingId: existing.id, userId: existing.user_id });
    } else {
      toCreate.push({ candidate });
    }
  }

  // Semua customer baru diproses dalam satu transaksi bulk. Placeholder unik
  // dipakai sementara untuk customer tanpa nomor telepon agar hasil RETURNING
  // tetap dapat dikorelasikan tanpa INSERT per customer.
  const seenCreatePhones = new Set();
  const seenCreateRunchiseIds = new Set();
  const bulkCreatable = [];
  for (const item of toCreate) {
    const { candidate } = item;
    if (candidate.normalizedPhone && seenCreatePhones.has(candidate.normalizedPhone)) {
      results[item.candidate.index] = {
        status: 'skipped_conflict',
        reason: 'duplicate_phone_in_batch',
      };
      continue;
    }
    if (seenCreateRunchiseIds.has(candidate.runchiseId)) {
      results[candidate.index] = {
        status: 'skipped_conflict',
        reason: 'duplicate_runchise_id_in_batch',
      };
      continue;
    }
    seenCreateRunchiseIds.add(candidate.runchiseId);
    if (candidate.normalizedPhone) seenCreatePhones.add(candidate.normalizedPhone);
    bulkCreatable.push(item);
  }

  // ---- 4. Bulk upsert brand yang direferensikan batch ini ----
  const brandIds = [...new Set(validCandidates.map((c) => c.brandId))];
  if (brandIds.length > 0) {
    await prisma.$executeRaw`
      INSERT INTO "Brand" (id, name, updated_at)
      VALUES ${Prisma.join(
        brandIds.map(
          (id) => Prisma.sql`(${id}::int, ${`Brand ${id}`}::text, CURRENT_TIMESTAMP)`,
        ),
      )}
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // ---- 5. Bulk update customer yang sudah ada + user + customer_locations ----
  // Membungkus pembaruan customer, user, dan customer_locations dalam satu transaksi untuk menjaga konsistensi data jika terjadi kegagalan di tengah proses.
  if (toUpdate.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "Customer" AS c
        SET
          runchise_id = v.runchise_id::int,
          runchise_location_id = v.runchise_location_id::int,
          runchise_sync_status = v.runchise_sync_status::text,
          runchise_sync_error = NULL,
          runchise_synced_at = v.runchise_synced_at::timestamp,
          runchise_created_at = v.runchise_created_at::timestamp,
          runchise_updated_at = v.runchise_updated_at::timestamp,
          name = v.name::text,
          phone_number = v.phone_number::text,
          normalized_phone_number = v.normalized_phone_number::text,
          phone_number_country_code = v.phone_number_country_code::int,
          address = v.address::text,
          province = v.province::text,
          city = v.city::text,
          country = v.country::text,
          postal_code = v.postal_code::text,
          dob = v.dob::date,
          gender = v.gender::text,
          status = v.status::text,
          balance = v.balance::numeric,
          brand_id = v.brand_id::int,
          owner_location_id = v.owner_location_id::int,
          updated_at = CURRENT_TIMESTAMP
        FROM (VALUES ${Prisma.join(
          toUpdate.map(({ existingId, candidate }) => {
            const p = candidate.payload;
            return Prisma.sql`(${existingId}::int, ${p.runchise_id}::int, ${p.runchise_location_id}::int, ${p.runchise_sync_status}::text, ${p.runchise_synced_at}::timestamp, ${p.runchise_created_at}::timestamp, ${p.runchise_updated_at}::timestamp, ${p.name}::text, ${p.phone_number}::text, ${p.normalized_phone_number}::text, ${p.phone_number_country_code}::int, ${p.address}::text, ${p.province}::text, ${p.city}::text, ${p.country}::text, ${p.postal_code}::text, ${p.dob}::date, ${p.gender}::text, ${p.status}::text, ${p.balance}::numeric, ${p.brand_id}::int, ${p.owner_location_id}::int)`;
          }),
        )}) AS v(id, runchise_id, runchise_location_id, runchise_sync_status, runchise_synced_at, runchise_created_at, runchise_updated_at, name, phone_number, normalized_phone_number, phone_number_country_code, address, province, city, country, postal_code, dob, gender, status, balance, brand_id, owner_location_id)
        WHERE c.id = v.id
      `;

      await tx.$executeRaw`
        UPDATE "User" AS u
        SET phone_number = v.phone_number, updated_at = CURRENT_TIMESTAMP
        FROM (VALUES ${Prisma.join(
          toUpdate.map(
            ({ userId, candidate }) =>
              Prisma.sql`(${userId}::int, ${candidate.payload.phone_number}::text)`,
          ),
        )}) AS v(user_id, phone_number)
        WHERE u.id = v.user_id
      `;

      const updateIds = toUpdate.map(({ existingId }) => existingId);
      await tx.$executeRaw`
        DELETE FROM "CustomerLocation" WHERE customer_id IN (${Prisma.join(updateIds)})
      `;

      const updateLocationTuples = toUpdate.flatMap(({ existingId, candidate }) =>
        candidate.locationIds.map(
          (locationId) => Prisma.sql`(${existingId}::int, ${locationId}::int)`,
        ),
      );
      if (updateLocationTuples.length > 0) {
        await tx.$executeRaw`
          INSERT INTO "CustomerLocation" (customer_id, location_id)
          VALUES ${Prisma.join(updateLocationTuples)}
          ON CONFLICT (customer_id, location_id) DO NOTHING
        `;
      }
    });

    for (const { candidate, existingId } of toUpdate) {
      results[candidate.index] = {
        status: 'updated',
        customer_id: existingId,
        unresolved_location_ids: candidate.unresolvedLocationIds,
      };
    }
  }

  // ---- 6. Bulk create user+customer baru (dengan atau tanpa nomor telepon) ----
  // Membuat user dan customer baru dalam satu transaksi untuk mencegah data yatim dan menjaga konsistensi saat terjadi kegagalan proses.
  if (bulkCreatable.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
      const userRows = await tx.$queryRaw`
        INSERT INTO "User" (phone_number, password_hash, activation_status, role, updated_at)
        VALUES ${Prisma.join(
          bulkCreatable.map(
            ({ candidate }) =>
              Prisma.sql`(${candidate.createPhone}::text, ${''}::text, ${'pending_activation'}::text, ${'customer'}::text, CURRENT_TIMESTAMP)`,
          ),
        )}
        RETURNING id, phone_number
      `;
      // Korelasi balik lewat nomor telepon (bukan urutan RETURNING): setiap
      // createPhone sudah dijamin unik dalam batch ini (nomor asli atau placeholder).
      const userIdByPhone = new Map(userRows.map((r) => [r.phone_number, r.id]));

      const customerTuples = bulkCreatable.map(({ candidate }) => {
        const p = candidate.payload;
        const userId = userIdByPhone.get(candidate.createPhone);
        return {
          candidate,
          userId,
          sql: Prisma.sql`(${userId}::int, ${p.runchise_id}::int, ${p.runchise_location_id}::int, ${p.runchise_sync_status}::text, ${p.runchise_synced_at}::timestamp, ${p.runchise_created_at}::timestamp, ${p.runchise_updated_at}::timestamp, ${p.name}::text, ${p.phone_number}::text, ${p.normalized_phone_number}::text, ${p.phone_number_country_code}::int, ${p.address}::text, ${p.province}::text, ${p.city}::text, ${p.country}::text, ${p.postal_code}::text, ${p.dob}::date, ${p.gender}::text, ${p.status}::text, ${p.balance}::numeric, ${p.brand_id}::int, ${p.owner_location_id}::int, CURRENT_TIMESTAMP)`,
        };
      });

      const customerRows = await tx.$queryRaw`
        INSERT INTO "Customer" (
          user_id, runchise_id, runchise_location_id, runchise_sync_status, runchise_synced_at,
          runchise_created_at, runchise_updated_at, name, phone_number, normalized_phone_number,
          phone_number_country_code, address, province, city, country, postal_code, dob, gender,
          status, balance, brand_id, owner_location_id, updated_at
        )
        VALUES ${Prisma.join(customerTuples.map((t) => t.sql))}
        RETURNING id, user_id
      `;
      // user_id dijamin unik (baru dibuat langkah di atas), jadi korelasi
      // balik lewat user_id aman walau ada NULL/duplikat di kolom lain.
      const customerIdByUserId = new Map(customerRows.map((r) => [r.user_id, r.id]));

      const nullPhoneUserIds = customerTuples
        .filter(({ candidate }) => !candidate.normalizedPhone)
        .map(({ userId }) => userId);
      if (nullPhoneUserIds.length > 0) {
        await tx.$executeRaw`
          UPDATE "User" SET phone_number = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${Prisma.join(nullPhoneUserIds)})
        `;
      }

      const createLocationTuples = [];
      for (const { candidate, userId } of customerTuples) {
        const customerId = customerIdByUserId.get(userId);
        results[candidate.index] = {
          status: 'created',
          customer_id: customerId,
          unresolved_location_ids: candidate.unresolvedLocationIds,
        };
        for (const locationId of candidate.locationIds) {
          createLocationTuples.push(
            Prisma.sql`(${customerId}::int, ${locationId}::int)`,
          );
        }
      }
      if (createLocationTuples.length > 0) {
        await tx.$executeRaw`
          INSERT INTO "CustomerLocation" (customer_id, location_id)
          VALUES ${Prisma.join(createLocationTuples)}
          ON CONFLICT (customer_id, location_id) DO NOTHING
        `;
      }
      });
    } catch (error) {
      // Jangan kembali ke N+1. Worker akan mengembalikan cursor ke queued dan
      // mengulang halaman secara atomik; P2002 tetap direkonsiliasi pada retry.
      throw error;
    }
  }

  return results;
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

function parsePointSnapshotInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

// Mengembalikan ID Runchise yang valid tanpa fallback numerik agar sinkronisasi selalu mengarah ke outlet yang benar.
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

// Menyimpan saldo poin dengan bulk upsert untuk mengurangi round-trip database dan meningkatkan efisiensi sinkronisasi.
async function bulkUpsertCustomerPoints(rows) {
  let written = 0;
  const validRows = rows.filter(
    (row) =>
      Number.isInteger(row.totalPoint) &&
      Number.isInteger(row.availablePoint) &&
      row.totalPoint >= 0 &&
      row.availablePoint >= 0 &&
      row.availablePoint <= row.totalPoint,
  );

  for (
    let index = 0;
    index < validRows.length;
    index += CUSTOMER_POINT_UPSERT_CHUNK
  ) {
    const chunk = validRows.slice(index, index + CUSTOMER_POINT_UPSERT_CHUNK);
    const tuples = Prisma.join(
      chunk.map(
        (row) =>
          Prisma.sql`(${row.customerId}, ${row.totalPoint}, ${row.availablePoint}, ${row.totalPoint}, ${row.availablePoint}, ${DEFAULT_NEXT_REWARD_THRESHOLD}, CURRENT_TIMESTAMP)`,
      ),
    );

    // next_reward_threshold sengaja tidak ikut diperbarui agar ambang batas
    // yang sudah disesuaikan per customer tidak tertimpa nilai default.
    written += await prisma.$executeRaw`
      INSERT INTO "CustomerPoint" (
        "customer_id", "total_point", "available_point",
        "runchise_total_point", "runchise_available_point",
        "next_reward_threshold", "updated_at"
      )
      VALUES ${tuples}
      ON CONFLICT ("customer_id") DO UPDATE SET
        "total_point" = "CustomerPoint"."total_point" +
          (EXCLUDED."runchise_total_point" - COALESCE(
            "CustomerPoint"."runchise_total_point",
            EXCLUDED."runchise_total_point"
          )),
        "available_point" = "CustomerPoint"."available_point" +
          (EXCLUDED."runchise_available_point" - COALESCE(
            "CustomerPoint"."runchise_available_point",
            EXCLUDED."runchise_available_point"
          )),
        "runchise_total_point" = EXCLUDED."runchise_total_point",
        "runchise_available_point" = EXCLUDED."runchise_available_point",
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        "CustomerPoint"."total_point" +
          (EXCLUDED."runchise_total_point" - COALESCE(
            "CustomerPoint"."runchise_total_point",
            EXCLUDED."runchise_total_point"
          )) >= 0
        AND "CustomerPoint"."available_point" +
          (EXCLUDED."runchise_available_point" - COALESCE(
            "CustomerPoint"."runchise_available_point",
            EXCLUDED."runchise_available_point"
          )) >= 0
        AND "CustomerPoint"."available_point" +
          (EXCLUDED."runchise_available_point" - COALESCE(
            "CustomerPoint"."runchise_available_point",
            EXCLUDED."runchise_available_point"
          )) <= "CustomerPoint"."total_point" +
          (EXCLUDED."runchise_total_point" - COALESCE(
            "CustomerPoint"."runchise_total_point",
            EXCLUDED."runchise_total_point"
          ))
    `;
  }

  return written;
}

// M-9: versi lama memanggil fetchAllCustomers/fetchAllCustomersAcrossLocations,
// yang menumpuk SELURUH customer dari SELURUH outlet (bisa ~10 ribu customer x
// 29 outlet) jadi satu array besar sebelum diproses satu baris pun -- padahal
// dari tiap customer cuma 2 angka (total_point, available_point) yang
// akhirnya dipakai. Sekarang di-stream per halaman per outlet (pola yang
// sama dengan syncCustomers), langsung diproyeksikan ke {customerId,
// totalPoint, availablePoint} begitu satu halaman selesai -- objek customer
// Runchise yang lengkap (nama, alamat, email, dst) tidak pernah menumpuk di
// memori melebihi satu halaman (item_per_page) sekaligus.
async function syncCustomerPoints({ locationId = null } = {}) {
  const targetLocationId = parseRunchiseId(locationId);
  const locationIds = targetLocationId
    ? [targetLocationId]
    : await getRunchiseSyncLocationIds();

  const localCustomers = await prisma.customer.findMany({
    where: { runchise_id: { not: null } },
    select: { id: true, runchise_id: true },
  });

  // Mapping runchise_id → local_id (biar cepat, tidak query DB berulang)
  const runchiseToLocal = new Map(
    localCustomers.map((c) => [c.runchise_id, c.id]),
  );

  // Dikunci per customer lokal supaya satu customer yang muncul di beberapa
  // outlet tetap menghasilkan tepat satu baris untuk ON CONFLICT.
  const pointsByCustomerId = new Map();
  let unmatched = 0;
  let totalScanned = 0;

  for (const outletId of locationIds) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      // M-2: cap halaman yang sama dengan syncCustomers() — mencegah loop poin
      // berjalan tanpa batas kalau paging.next_page dari Runchise tak pernah null.
      assertPageWithinLimit('customers', page);
      const data = await fetchCustomersPage(outletId, page);
      const customers = Array.isArray(data.customers) ? data.customers : [];
      totalScanned += customers.length;

      for (const c of customers) {
        const localId = runchiseToLocal.get(parseRunchiseId(c.id));
        if (!localId) {
          unmatched++;
          continue;
        }

        // Snapshot POS disimpan sebagai baseline terpisah. Saldo efektif
        // menerima deltanya agar mutasi lokal tidak terhapus saat sync.
        pointsByCustomerId.set(localId, {
          customerId: localId,
          totalPoint: parsePointSnapshotInteger(c.total_point),
          availablePoint: parsePointSnapshotInteger(c.available_point),
        });
      }

      hasMore = data.paging?.next_page != null;
      page++;
    }
  }

  const rows = [...pointsByCustomerId.values()];
  const synced = await bulkUpsertCustomerPoints(rows);

  return {
    scope: targetLocationId ? `location:${targetLocationId}` : 'all-locations',
    synced,
    rejected_invalid_balance: rows.length - synced,
    matched: rows.length,
    unmatched,
    total: totalScanned,
    local_customers: localCustomers.length,
  };
}

// Sinkronisasi poin menggunakan data staging untuk mempercepat proses tanpa request API, sekaligus memverifikasi konsistensi poin customer antar outlet.
async function syncCustomerPointsFromStaging() {
  const [diagnostics] = await prisma.$queryRaw`
    WITH source_rows AS (
      SELECT DISTINCT ON (c."id")
        c."id",
        rlc."total_point" AS total_point,
        rlc."available_point" AS available_point
      FROM "Customer" c
      JOIN "RunchiseLocationCustomer" rlc
        ON rlc."runchise_customer_id" = c."runchise_id"
      WHERE c."runchise_id" IS NOT NULL
      ORDER BY c."id", rlc."updated_at" DESC NULLS LAST,
        rlc."source_location_id" DESC
    ), divergent AS (
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
    )
    SELECT
      (SELECT COUNT(*)::int FROM divergent) AS divergent_customers,
      COUNT(*)::int AS source_customers,
      COUNT(*) FILTER (
        WHERE total_point IS NULL
           OR available_point IS NULL
           OR total_point < 0
           OR available_point < 0
           OR available_point > total_point
      )::int AS invalid_source_customers
    FROM source_rows
  `;

// Menggunakan `DISTINCT ON` untuk mengambil snapshot terbaru setiap customer sebelum proses insert atau update.
  const synced = await prisma.$executeRaw`
    WITH latest_points AS (
      SELECT DISTINCT ON (c."id")
        c."id" AS customer_id,
        rlc."total_point" AS total_point,
        rlc."available_point" AS available_point
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
      "runchise_total_point", "runchise_available_point",
      "next_reward_threshold", "updated_at"
    )
    SELECT
      "customer_id",
      "total_point",
      "available_point",
      "total_point",
      "available_point",
      ${DEFAULT_NEXT_REWARD_THRESHOLD}::int,
      CURRENT_TIMESTAMP
    FROM latest_points
    WHERE "total_point" IS NOT NULL
      AND "available_point" IS NOT NULL
      AND "total_point" >= 0
      AND "available_point" >= 0
      AND "available_point" <= "total_point"
    ON CONFLICT ("customer_id") DO UPDATE SET
      "total_point" = "CustomerPoint"."total_point" +
        (EXCLUDED."runchise_total_point" - COALESCE(
          "CustomerPoint"."runchise_total_point",
          EXCLUDED."runchise_total_point"
        )),
      "available_point" = "CustomerPoint"."available_point" +
        (EXCLUDED."runchise_available_point" - COALESCE(
          "CustomerPoint"."runchise_available_point",
          EXCLUDED."runchise_available_point"
        )),
      "runchise_total_point" = EXCLUDED."runchise_total_point",
      "runchise_available_point" = EXCLUDED."runchise_available_point",
      "updated_at" = CURRENT_TIMESTAMP
    WHERE
      "CustomerPoint"."total_point" +
        (EXCLUDED."runchise_total_point" - COALESCE(
          "CustomerPoint"."runchise_total_point",
          EXCLUDED."runchise_total_point"
        )) >= 0
      AND "CustomerPoint"."available_point" +
        (EXCLUDED."runchise_available_point" - COALESCE(
          "CustomerPoint"."runchise_available_point",
          EXCLUDED."runchise_available_point"
        )) >= 0
      AND "CustomerPoint"."available_point" +
        (EXCLUDED."runchise_available_point" - COALESCE(
          "CustomerPoint"."runchise_available_point",
          EXCLUDED."runchise_available_point"
        )) <= "CustomerPoint"."total_point" +
        (EXCLUDED."runchise_total_point" - COALESCE(
          "CustomerPoint"."runchise_total_point",
          EXCLUDED."runchise_total_point"
        ))
  `;

  return {
    scope: 'all-locations',
    source: 'staging',
    synced,
    divergent_customers: diagnostics?.divergent_customers ?? 0,
    rejected_invalid_balance:
      (diagnostics?.source_customers ?? 0) - synced,
    invalid_source_customers: diagnostics?.invalid_source_customers ?? 0,
  };
}

// SUM() Postgres atas kolom int menghasilkan bigint, yang diterima Prisma
// sebagai BigInt dan tidak dapat diserialisasi JSON.stringify.
function bigIntToNumber(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

// Diagnostik read-only untuk memverifikasi apakah saldo poin customer konsisten antar outlet sehingga strategi penggabungan data tetap akurat.
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

// M-9: Menyimpan hanya subset field transaksi Runchise yang benar-benar digunakan untuk proses reward redemption guna mengurangi ukuran penyimpanan tanpa mengubah fungsionalitas.
function pickLoyaltyContainer(container) {
  if (!container || typeof container !== 'object') return null;

  return {
    redeemed_point: container.redeemed_point ?? null,
    loyalty_products: Array.isArray(container.loyalty_products)
      ? container.loyalty_products
      : [],
  };
}

function buildSaleRewardRedemptionSnapshot(sale) {
  if (!sale || typeof sale !== 'object') return null;

  return {
    id: sale.id ?? null,
    customer_id: sale.customer_id ?? null,
    customer_name: sale.customer_name ?? null,
    customer_phone_number: sale.customer_phone_number ?? null,
    customer_phone_number_country_code:
      sale.customer_phone_number_country_code ?? null,
    location_id: sale.location_id ?? null,
    location_name: sale.location_name ?? null,
    sales_time: sale.sales_time ?? null,
    local_sales_time: sale.local_sales_time ?? null,
    loyalty: pickLoyaltyContainer(sale.loyalty),
    metadata: sale.metadata
      ? {
          redeemed_point: sale.metadata.redeemed_point ?? null,
          loyalty: pickLoyaltyContainer(sale.metadata.loyalty),
        }
      : null,
    sale_detail_transactions: Array.isArray(sale.sale_detail_transactions)
      ? sale.sale_detail_transactions.map((detail) => ({
          id: detail?.id ?? null,
          product_id: detail?.product_id ?? null,
          product_name: detail?.product_name ?? null,
          price: detail?.price ?? null,
          quantity: detail?.quantity ?? null,
          cancelled_quantity: detail?.cancelled_quantity ?? null,
          deleted: detail?.deleted ?? null,
          meta:
            detail?.meta && typeof detail.meta === 'object'
              ? { sell_price: detail.meta.sell_price ?? null }
              : null,
        }))
      : [],
  };
}

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
    raw: buildSaleRewardRedemptionSnapshot(sale),
  };
}

// M-9: versi lama memanggil fetchAllCustomers(targetLocationId), yang
// menumpuk seluruh customer outlet ini (bisa sampai 10 ribu) jadi satu array
// besar berisi objek customer LENGKAP -- padahal mapSalesTransactionReportData
// di bawah cuma memakai 6 field dari tiap customer Runchise (nama, telepon +
// kode negaranya, tanggal dibuat, nama outlet pemilik, poin tersedia).
// Sekarang di-stream per halaman (pola yang sama dengan syncCustomers) dan
// langsung diproyeksikan ke 6 field itu saja, bukan menumpuk objek penuh.
async function fetchRunchiseCustomerLookupForLocation(targetLocationId) {
  const lookup = new Map();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    // M-2: cap halaman yang sama dengan fetchAllCustomers() — lookup ini
    // dipakai per outlet saat sync sales-transaction, jadi rawan hal yang
    // sama kalau next_page tak pernah null.
    assertPageWithinLimit('customers', page);
    const data = await fetchCustomersPage(targetLocationId, page);
    const customers = Array.isArray(data.customers) ? data.customers : [];

    for (const c of customers) {
      const id = Number(c.id);
      if (!Number.isInteger(id) || id <= 0) continue;

      lookup.set(id, {
        name: c.name,
        phone_number: c.phone_number,
        phone_number_country_code: c.phone_number_country_code,
        created_at: c.created_at,
        available_point: c.available_point,
        owner_location: c.owner_location
          ? { name: c.owner_location.name }
          : null,
      });
    }

    hasMore = data.paging?.next_page != null;
    page++;
  }

  return lookup;
}

async function syncSalesTransactionReportsForLocation(targetLocationId, options = {}) {
  const params = buildSalesTransactionParams({
    locationId: targetLocationId,
    startDate: options.startDate ?? options.start_date ?? options.from,
    endDate: options.endDate ?? options.end_date ?? options.to,
    status: options.status,
    paymentMethodIds: options.paymentMethodIds ?? options.payment_method_ids,
  });
  let synced = 0;
  let skipped = 0;
  let skippedZeroPoints = 0;
  let total = 0;

  // Jalur manual/CLI juga memakai unit kerja page+bulk yang sama dengan
  // worker cron. Tidak ada lagi array full-history maupun upsert per sale.
  for await (const batch of iterateSalesTransactionPages(params)) {
    const result = await syncSalesTransactionReportsPage(
      targetLocationId,
      batch.transactions,
    );
    total += result.processed;
    synced += result.synced;
    skipped += result.skipped_invalid;
    skippedZeroPoints += result.skipped_zero_points;
  }

  return {
    location_id: targetLocationId,
    synced,
    total,
    skipped,
    skipped_zero_points: skippedZeroPoints,
    deleted_zero_points: skippedZeroPoints,
  };
}

// Unit kerja worker serverless: tepat satu halaman transaksi. Seluruh lookup
// dibatasi ke customer yang muncul pada halaman ini dan seluruh write dijalankan
// dalam satu transaksi, sehingga cursor job baru boleh maju setelah halaman
// tersimpan lengkap.
async function syncSalesTransactionReportsPage(
  targetLocationId,
  salesTransactions,
  db = prisma,
) {
  const runchiseCustomerIds = [
    ...new Set(
      salesTransactions
        .map((sale) => Number(sale.customer_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  const [stagedCustomers, localCustomers] = await Promise.all([
    runchiseCustomerIds.length > 0
      ? db.runchiseLocationCustomer.findMany({
          where: {
            source_location_id: Number(targetLocationId),
            runchise_customer_id: { in: runchiseCustomerIds },
          },
          select: {
            runchise_customer_id: true,
            name: true,
            phone_number: true,
            phone_number_country_code: true,
            runchise_created_at: true,
            available_point: true,
            owner_location_name: true,
          },
        })
      : [],
    runchiseCustomerIds.length > 0
      ? db.customer.findMany({
          where: { runchise_id: { in: runchiseCustomerIds } },
          include: {
            owner_location: { select: { id: true, name: true, city: true } },
            customer_point: true,
          },
        })
      : [],
  ]);
  const stagedById = new Map(
    stagedCustomers.map((customer) => [
      Number(customer.runchise_customer_id),
      {
        name: customer.name,
        phone_number: customer.phone_number,
        phone_number_country_code: customer.phone_number_country_code,
        created_at: customer.runchise_created_at,
        available_point: customer.available_point,
        owner_location: customer.owner_location_name
          ? { name: customer.owner_location_name }
          : null,
      },
    ]),
  );
  const localById = new Map(
    localCustomers.map((customer) => [Number(customer.runchise_id), customer]),
  );

  const upsertRows = [];
  const zeroPointKeys = [];
  let synced = 0;
  let skipped = 0;
  let skippedZeroPoints = 0;

  for (const sale of salesTransactions) {
    const saleId = Number(sale.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      skipped++;
      continue;
    }

    const customerId = Number(sale.customer_id);
    const data = mapSalesTransactionReportData(
      sale,
      stagedById.get(customerId),
      localById.get(customerId),
      targetLocationId,
    );

    if (data.penambahan_poin === 0 && Number(data.penggunaan_poin) === 0) {
      zeroPointKeys.push({
        source_location_id: Number(targetLocationId),
        runchise_sales_transaction_id: saleId,
      });
      skippedZeroPoints++;
      continue;
    }

    upsertRows.push(data);
    synced++;
  }

  await bulkWriteSalesTransactionReports(db, upsertRows, zeroPointKeys);
  return {
    processed: salesTransactions.length,
    synced,
    skipped: skipped + skippedZeroPoints,
    skipped_invalid: skipped,
    skipped_zero_points: skippedZeroPoints,
  };
}

function serializeSalesReportRow(row) {
  const serialized = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) serialized[key] = value.toISOString();
    else if (typeof value === 'bigint') serialized[key] = value.toString();
    else if (value && typeof value.toNumber === 'function') {
      serialized[key] = value.toNumber();
    } else serialized[key] = value ?? null;
  }
  return serialized;
}

// Maksimal dua statement data per halaman, dibungkus satu transaksi:
// bulk-delete koreksi nol poin dan bulk-upsert seluruh report lainnya.
async function bulkWriteSalesTransactionReports(db, upsertRows, zeroPointKeys) {
  if (upsertRows.length === 0 && zeroPointKeys.length === 0) return;

  const serializedRows = upsertRows.map(serializeSalesReportRow);
  await db.$transaction(async (tx) => {
    if (zeroPointKeys.length > 0) {
      await tx.$executeRaw`
        DELETE FROM "CustomerSalesTransactionReport" report
        USING jsonb_to_recordset(${JSON.stringify(zeroPointKeys)}::jsonb) AS incoming(
          source_location_id integer,
          runchise_sales_transaction_id integer
        )
        WHERE report."source_location_id" = incoming.source_location_id
          AND report."runchise_sales_transaction_id" = incoming.runchise_sales_transaction_id
      `;
    }

    if (serializedRows.length > 0) {
      await tx.$executeRaw`
        INSERT INTO "CustomerSalesTransactionReport" (
          "source_location_id", "runchise_sales_transaction_id",
          "runchise_customer_id", "customer_id", "runchise_location_id",
          "nama_pelanggan", "no_telepon", "lokasi_dibuat",
          "pelanggan_sejak", "poin_pelanggan", "tanggal_transaksi",
          "nama_outlet", "tipe_order", "pembelian_per_order",
          "penambahan_poin", "penggunaan_poin", "sales_no", "receipt_no",
          "status", "is_deleted", "nominal_transaksi", "jumlah_diterima",
          "jumlah_kembalian", "sumber_nominal", "payment_methods",
          "customer_snapshot_at", "import_run_id", "raw", "updated_at"
        )
        SELECT
          incoming.source_location_id,
          incoming.runchise_sales_transaction_id,
          incoming.runchise_customer_id,
          incoming.customer_id,
          incoming.runchise_location_id,
          incoming.nama_pelanggan,
          incoming.no_telepon,
          incoming.lokasi_dibuat,
          incoming.pelanggan_sejak,
          COALESCE(incoming.poin_pelanggan, 0),
          incoming.tanggal_transaksi,
          incoming.nama_outlet,
          incoming.tipe_order,
          COALESCE(incoming.pembelian_per_order, 0),
          COALESCE(incoming.penambahan_poin, 0),
          COALESCE(incoming.penggunaan_poin, 0),
          incoming.sales_no,
          incoming.receipt_no,
          incoming.status,
          COALESCE(incoming.is_deleted, FALSE),
          COALESCE(incoming.nominal_transaksi, 0),
          COALESCE(incoming.jumlah_diterima, 0),
          COALESCE(incoming.jumlah_kembalian, 0),
          incoming.sumber_nominal,
          incoming.payment_methods,
          incoming.customer_snapshot_at,
          incoming.import_run_id,
          incoming.raw,
          CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${JSON.stringify(serializedRows)}::jsonb) AS incoming(
          source_location_id integer,
          runchise_sales_transaction_id integer,
          runchise_customer_id integer,
          customer_id integer,
          runchise_location_id integer,
          nama_pelanggan text,
          no_telepon text,
          lokasi_dibuat text,
          pelanggan_sejak timestamp,
          poin_pelanggan integer,
          tanggal_transaksi timestamp,
          nama_outlet text,
          tipe_order text,
          pembelian_per_order numeric,
          penambahan_poin integer,
          penggunaan_poin numeric,
          sales_no text,
          receipt_no text,
          status text,
          is_deleted boolean,
          nominal_transaksi numeric,
          jumlah_diterima numeric,
          jumlah_kembalian numeric,
          sumber_nominal text,
          payment_methods text,
          customer_snapshot_at timestamp,
          import_run_id bigint,
          raw jsonb
        )
        ON CONFLICT ("source_location_id", "runchise_sales_transaction_id")
        DO UPDATE SET
          "runchise_customer_id" = EXCLUDED."runchise_customer_id",
          "customer_id" = EXCLUDED."customer_id",
          "runchise_location_id" = EXCLUDED."runchise_location_id",
          "nama_pelanggan" = EXCLUDED."nama_pelanggan",
          "no_telepon" = EXCLUDED."no_telepon",
          "lokasi_dibuat" = EXCLUDED."lokasi_dibuat",
          "pelanggan_sejak" = EXCLUDED."pelanggan_sejak",
          "poin_pelanggan" = EXCLUDED."poin_pelanggan",
          "tanggal_transaksi" = EXCLUDED."tanggal_transaksi",
          "nama_outlet" = EXCLUDED."nama_outlet",
          "tipe_order" = EXCLUDED."tipe_order",
          "pembelian_per_order" = EXCLUDED."pembelian_per_order",
          "penambahan_poin" = EXCLUDED."penambahan_poin",
          "penggunaan_poin" = EXCLUDED."penggunaan_poin",
          "sales_no" = EXCLUDED."sales_no",
          "receipt_no" = EXCLUDED."receipt_no",
          "status" = EXCLUDED."status",
          "is_deleted" = EXCLUDED."is_deleted",
          "nominal_transaksi" = EXCLUDED."nominal_transaksi",
          "jumlah_diterima" = EXCLUDED."jumlah_diterima",
          "jumlah_kembalian" = EXCLUDED."jumlah_kembalian",
          "sumber_nominal" = EXCLUDED."sumber_nominal",
          "payment_methods" = EXCLUDED."payment_methods",
          "customer_snapshot_at" = EXCLUDED."customer_snapshot_at",
          "import_run_id" = EXCLUDED."import_run_id",
          "raw" = EXCLUDED."raw",
          "updated_at" = CURRENT_TIMESTAMP
      `;
    }
  });
}

// Tanpa locationId, sinkronisasi terjadwal wajib mencakup seluruh outlet yang
// tersedia dari Runchise. locationId eksplisit tetap didukung untuk operasi
// manual/diagnostik satu outlet.
async function syncSalesTransactionReports(locationId = null, options = {}) {
  const targetLocationId = parseRunchiseId(locationId);
  const hasExplicitLocationId =
    locationId !== null && locationId !== undefined && locationId !== '';

  if (hasExplicitLocationId && !targetLocationId) {
    throw new Error('locationId harus berupa ID outlet Runchise yang valid');
  }

  const locationIds = targetLocationId
    ? [targetLocationId]
    : await getRunchiseSyncLocationIds();
  return syncSalesAcrossLocations({
    locationIds,
    syncLocation: (outletId) =>
      syncSalesTransactionReportsForLocation(outletId, options),
  });
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
    // M-9: raw promo (blob JSON penuh dari Runchise) TIDAK disimpan lagi.
    // Diverifikasi lewat grep menyeluruh: tidak ada satu kode pun (backend
    // atau frontend) yang pernah membaca kolom ini kembali -- mapPromo() di
    // promoRoutes.js bahkan sudah memfilternya keluar dari respons API sejak
    // awal. Berbeda dengan raw sale (CustomerSalesTransactionReport), yang
    // memang masih dipakai runchisePosRewardRedemptionService.js untuk
    // mengekstrak detail redeem POS, sehingga TIDAK disentuh oleh perbaikan
    // ini. Kolom raw di skema Promo sengaja tidak dihapus (bukan migration).
    // upsertPromoChunk() memakai objek ini utuh sebagai `update`, jadi nilai
    // null di sini otomatis MEMBERSIHKAN blob lama juga begitu promo
    // tersebut ikut ter-sync ulang (cron promo berjalan harian) -- bukan
    // cuma mencegah pertumbuhan baru.
    raw: null,
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
  upsertRunchiseCustomersBatch,
  syncProducts,
  syncCustomerPoints,
  syncCustomerPointsFromStaging,
  bulkUpsertCustomerPoints,
  inspectCustomerPointSources,
  syncSalesTransactionReports,
  syncBrands,
  syncLocations,
  ensureLocalLocationRunchiseMapping,
  fetchRunchiseCustomerLookupForLocation,
  getCrisbarPromoEvidence,
  loadCrisbarPromoContext,
  mapRunchisePromoToLocalData,
  syncPromos,
  buildSaleRewardRedemptionSnapshot,
  mapSalesTransactionReportData,
  buildSalesTransactionParams,
  syncSalesTransactionReportsPage,
  bulkWriteSalesTransactionReports,
  serializeSalesReportRow,
};
