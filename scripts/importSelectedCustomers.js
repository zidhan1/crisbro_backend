const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../src/lib/prisma');

const DEFAULT_LOCATION_ID = 4453;
const DEFAULT_YEAR = 2026;
const DEFAULT_EXPECTED_TOTAL = 208;
const PAGE_SIZE = 100;
// Interactive transaction ke Supabase pooler memiliki latency per query.
// Sepuluh customer menjaga setiap transaksi jauh di bawah timeout 30 detik,
// sementara rerun tetap aman karena seluruh operasi bersifat upsert.
const WRITE_CHUNK_SIZE = 10;
const MAX_PAGES = 1000;
const DEFAULT_MAX_DATABASE_MB = 250;
const WRITE_FLAG = '--confirm-db-write';

function printHelp() {
  console.log(`
Import customer Runchise secara selektif, streaming per halaman.

Penggunaan:
  npm run import:selected-customers
  npm run import:selected-customers -- --confirm-db-write
  npm run import:selected-customers -- --location=4453 --year=2026 --expected-total=208

Default:
  location=${DEFAULT_LOCATION_ID}, year=${DEFAULT_YEAR}, expected-total=${DEFAULT_EXPECTED_TOTAL}

Pengamanan:
  - Default dry-run dan tidak menulis database.
  - Filter API selalu memakai created_after dan created_before.
  - Data diproses maksimal ${PAGE_SIZE} customer per halaman.
  - Tidak menyimpan staging atau raw JSON.
  - Database write berhenti sebelum melewati batas storage.
`);
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOption(args, name, fallback) {
  const prefix = `--${name}=`;
  const argument = args.find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function parseOptions(args) {
  const locationId = positiveInt(parseOption(args, 'location', DEFAULT_LOCATION_ID));
  const year = positiveInt(parseOption(args, 'year', DEFAULT_YEAR));
  const expectedTotal = positiveInt(
    parseOption(args, 'expected-total', DEFAULT_EXPECTED_TOTAL),
  );
  const maxDatabaseMb = positiveInt(
    parseOption(args, 'max-database-mb', DEFAULT_MAX_DATABASE_MB),
  );
  if (!locationId) throw new Error('--location harus berupa integer positif');
  if (!year || year < 2000 || year > 2100) throw new Error('--year tidak valid');
  if (!expectedTotal) throw new Error('--expected-total harus berupa integer positif');
  if (!maxDatabaseMb) throw new Error('--max-database-mb harus berupa integer positif');

  return {
    locationId,
    year,
    expectedTotal,
    maxDatabaseBytes: maxDatabaseMb * 1024 * 1024,
    startDate: `${year}-01-01`,
    endDate: `${year + 1}-01-01`,
  };
}

function optionalText(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function normalizePhone(value, countryCode = 62) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const code = String(countryCode || 62).replace(/\D/g, '') || '62';
  let national = digits;
  if (national.startsWith(code)) national = national.slice(code.length);
  if (national.startsWith('0')) national = national.slice(1);
  return /^8\d{7,13}$/.test(national) ? national : null;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function parseDecimal(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function locationIdsOf(customer) {
  const ids = Array.isArray(customer?.location_ids) ? customer.location_ids : [];
  const ownerId = customer?.owner_location_id;
  return [
    ...new Set([...ids, ownerId].map(positiveInt).filter(Boolean)),
  ];
}

function mapCustomer(customer, options) {
  const runchiseId = positiveInt(customer?.id);
  const brandRunchiseId = positiveInt(customer?.brand_id);
  const name = optionalText(customer?.name);
  const phone = normalizePhone(
    customer?.phone_number,
    customer?.phone_number_country_code,
  );
  const createdAt = parseDate(customer?.created_at);
  const updatedAt = parseDate(customer?.updated_at);
  const start = new Date(`${options.startDate}T00:00:00.000Z`);
  const end = new Date(`${options.endDate}T00:00:00.000Z`);
  const locationIds = locationIdsOf(customer);

  if (!runchiseId || !brandRunchiseId || !name || !phone || !createdAt) {
    return { valid: false, reason: !phone ? 'invalid_phone' : 'invalid_required_field' };
  }
  if (createdAt < start || createdAt >= end) {
    return { valid: false, reason: 'outside_period' };
  }
  if (!locationIds.includes(options.locationId)) {
    return { valid: false, reason: 'location_mismatch' };
  }

  return {
    valid: true,
    data: {
      runchise_id: runchiseId,
      brand_runchise_id: brandRunchiseId,
      source_location_id: options.locationId,
      location_ids: locationIds,
      owner_location_runchise_id: positiveInt(customer.owner_location_id),
      phone_number: phone,
      name,
      address: optionalText(customer.address),
      province: optionalText(customer.province),
      city: optionalText(customer.city),
      country: optionalText(customer.country),
      postal_code: optionalText(customer.postal_code),
      dob: parseDate(customer.dob),
      gender: optionalText(customer.gender) ?? 'unknown',
      status: optionalText(customer.status) ?? 'active',
      balance: parseDecimal(customer.balance),
      phone_number_country_code: positiveInt(customer.phone_number_country_code) ?? 62,
      runchise_created_at: createdAt,
      runchise_updated_at: updatedAt,
      total_point: parseInteger(customer.total_point),
      available_point: parseInteger(customer.available_point),
    },
  };
}

function createStats() {
  return {
    pages: 0,
    api_rows: 0,
    valid_rows: 0,
    unique_customers: 0,
    duplicates_in_response: 0,
    invalid_phone: 0,
    invalid_required_field: 0,
    outside_period: 0,
    location_mismatch: 0,
    inserted: 0,
    updated: 0,
    skipped_conflicts: 0,
    points_upserted: 0,
    customer_locations_created: 0,
  };
}

function apiClient() {
  if (!process.env.RUNCHISE_API_KEY) {
    throw new Error('RUNCHISE_API_KEY tidak tersedia');
  }
  return axios.create({
    baseURL: 'https://api.runchise.com/api/public',
    timeout: Number(process.env.RUNCHISE_API_TIMEOUT_MS || 30000),
    headers: { Accept: 'application/json', Authorization: process.env.RUNCHISE_API_KEY },
  });
}

async function fetchPageWithRetry(client, options, page) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { data } = await client.get(`/locations/${options.locationId}/customers`, {
        params: {
          created_after: options.startDate,
          created_before: options.endDate,
          location_id: options.locationId,
          page,
          item_per_page: PAGE_SIZE,
        },
      });
      if (!Array.isArray(data?.customers)) {
        throw new Error('Response tidak memiliki array customers');
      }
      return data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (attempt === 4 || (status && status < 500 && status !== 429)) break;
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delayMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 500 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function databaseBytes(db) {
  const rows = await db.$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  return Number(rows[0]?.bytes ?? 0);
}

async function writeCustomer(tx, customer, lookup) {
  const brandId = lookup.brandByRunchiseId.get(customer.brand_runchise_id);
  if (!brandId) return { status: 'conflict', reason: 'brand_not_found' };

  const localLocationIds = customer.location_ids
    .map((id) => lookup.locationByRunchiseId.get(id))
    .filter(Boolean);
  const sourceLocalLocationId = lookup.locationByRunchiseId.get(customer.source_location_id);
  if (!sourceLocalLocationId || localLocationIds.length === 0) {
    return { status: 'conflict', reason: 'location_not_found' };
  }
  const ownerLocationId = customer.owner_location_runchise_id
    ? lookup.locationByRunchiseId.get(customer.owner_location_runchise_id) ?? null
    : null;

  const [existingCustomer, phoneUser] = await Promise.all([
    tx.customer.findUnique({
      where: { runchise_id: customer.runchise_id },
      include: { user: { select: { id: true, phone_number: true, activation_status: true } } },
    }),
    tx.user.findUnique({
      where: { phone_number: customer.phone_number },
      include: { customer: { select: { id: true, runchise_id: true } } },
    }),
  ]);

  if (
    phoneUser &&
    (!existingCustomer || phoneUser.id !== existingCustomer.user_id) &&
    phoneUser.customer?.runchise_id !== customer.runchise_id
  ) {
    return { status: 'conflict', reason: 'phone_in_use' };
  }

  const payload = {
    runchise_id: customer.runchise_id,
    runchise_location_id: customer.owner_location_runchise_id ?? customer.source_location_id,
    runchise_sync_status: 'synced',
    runchise_sync_error: null,
    runchise_synced_at: new Date(),
    runchise_created_at: customer.runchise_created_at,
    runchise_updated_at: customer.runchise_updated_at,
    name: customer.name,
    phone_number: customer.phone_number,
    normalized_phone_number: customer.phone_number,
    phone_number_country_code: customer.phone_number_country_code,
    address: customer.address,
    province: customer.province,
    city: customer.city,
    country: customer.country,
    postal_code: customer.postal_code,
    dob: customer.dob,
    gender: customer.gender,
    status: customer.status,
    balance: customer.balance,
    member_since: customer.runchise_created_at,
    brand_id: brandId,
    owner_location_id: ownerLocationId,
  };

  let localCustomer;
  let status;
  if (existingCustomer) {
    if (
      existingCustomer.user.activation_status === 'active' &&
      existingCustomer.user.phone_number !== customer.phone_number
    ) {
      return { status: 'conflict', reason: 'active_user_phone_changed' };
    }
    localCustomer = await tx.customer.update({
      where: { id: existingCustomer.id },
      data: payload,
      select: { id: true },
    });
    if (existingCustomer.user.activation_status !== 'active') {
      await tx.user.update({
        where: { id: existingCustomer.user_id },
        data: { phone_number: customer.phone_number },
      });
    }
    status = 'updated';
  } else {
    const user = await tx.user.create({
      data: {
        phone_number: customer.phone_number,
        password_hash: '',
        activation_status: 'pending_activation',
        role: 'customer',
        customer: { create: payload },
      },
      select: { customer: { select: { id: true } } },
    });
    localCustomer = user.customer;
    status = 'inserted';
  }

  const existingRelations = await tx.customerLocation.findMany({
    where: { customer_id: localCustomer.id, location_id: { in: localLocationIds } },
    select: { location_id: true },
  });
  const existingRelationIds = new Set(existingRelations.map((item) => item.location_id));
  const newRelations = localLocationIds.filter((id) => !existingRelationIds.has(id));
  if (newRelations.length > 0) {
    await tx.customerLocation.createMany({
      data: newRelations.map((locationId) => ({
        customer_id: localCustomer.id,
        location_id: locationId,
      })),
      skipDuplicates: true,
    });
  }

  await tx.customerPoint.upsert({
    where: { customer_id: localCustomer.id },
    update: {
      total_point: customer.total_point,
      available_point: customer.available_point,
    },
    create: {
      customer_id: localCustomer.id,
      total_point: customer.total_point,
      available_point: customer.available_point,
    },
  });

  return { status, relationsCreated: newRelations.length };
}

async function buildLookup(tx) {
  const [brands, locations] = await Promise.all([
    tx.brand.findMany({
      where: { runchise_id: { not: null } },
      select: { id: true, runchise_id: true },
    }),
    tx.location.findMany({
      where: { runchise_id: { not: null } },
      select: { id: true, runchise_id: true },
    }),
  ]);
  return {
    brandByRunchiseId: new Map(brands.map((item) => [item.runchise_id, item.id])),
    locationByRunchiseId: new Map(locations.map((item) => [item.runchise_id, item.id])),
  };
}

async function runImport(options, writeEnabled) {
  const client = apiClient();
  const stats = createStats();
  const seenCustomerIds = new Set();
  let reportedTotal = null;
  let page = 1;
  const beforeBytes = writeEnabled ? await databaseBytes(prisma) : null;

  while (page <= MAX_PAGES) {
    const data = await fetchPageWithRetry(client, options, page);
    const pageTotal = positiveInt(data.paging?.total_item) ?? 0;
    if (reportedTotal === null) {
      reportedTotal = pageTotal;
      if (reportedTotal !== options.expectedTotal) {
        throw new Error(
          `API melaporkan total ${reportedTotal}; expected ${options.expectedTotal}. Import dibatalkan.`,
        );
      }
    } else if (pageTotal !== reportedTotal) {
      throw new Error(`total_item berubah saat pagination: ${reportedTotal} -> ${pageTotal}`);
    }

    stats.pages++;
    stats.api_rows += data.customers.length;
    const validCustomers = [];
    for (const rawCustomer of data.customers) {
      const mapped = mapCustomer(rawCustomer, options);
      if (!mapped.valid) {
        stats[mapped.reason]++;
        continue;
      }
      if (seenCustomerIds.has(mapped.data.runchise_id)) {
        stats.duplicates_in_response++;
        continue;
      }
      seenCustomerIds.add(mapped.data.runchise_id);
      stats.valid_rows++;
      validCustomers.push(mapped.data);
    }

    if (writeEnabled && validCustomers.length > 0) {
      for (let offset = 0; offset < validCustomers.length; offset += WRITE_CHUNK_SIZE) {
        const currentBytes = await databaseBytes(prisma);
        if (currentBytes >= options.maxDatabaseBytes) {
          throw new Error('Batas ukuran database tercapai sebelum menulis chunk berikutnya');
        }
        const chunk = validCustomers.slice(offset, offset + WRITE_CHUNK_SIZE);
        const chunkResult = await prisma.$transaction(async (tx) => {
          const lookup = await buildLookup(tx);
          const totals = { inserted: 0, updated: 0, conflicts: 0, relations: 0 };
          for (const customer of chunk) {
            const result = await writeCustomer(tx, customer, lookup);
            if (result.status === 'conflict') totals.conflicts++;
            else {
              totals[result.status]++;
              totals.relations += result.relationsCreated;
            }
          }
          return totals;
        }, { timeout: 30000 });
        stats.inserted += chunkResult.inserted;
        stats.updated += chunkResult.updated;
        stats.skipped_conflicts += chunkResult.conflicts;
        stats.customer_locations_created += chunkResult.relations;
        stats.points_upserted += chunkResult.inserted + chunkResult.updated;
      }
    }

    console.log(
      `Halaman ${page}: API=${data.customers.length}, valid=${validCustomers.length}, ` +
        `unik=${seenCustomerIds.size}${writeEnabled ? `, inserted=${stats.inserted}, updated=${stats.updated}` : ''}`,
    );
    if (data.customers.length === 0 || stats.api_rows >= reportedTotal) break;
    page++;
  }

  if (page > MAX_PAGES) throw new Error(`Pagination melebihi ${MAX_PAGES} halaman`);
  if (stats.api_rows !== reportedTotal) {
    throw new Error(`Pagination tidak lengkap: diterima ${stats.api_rows}/${reportedTotal}`);
  }
  stats.unique_customers = seenCustomerIds.size;

  const afterBytes = writeEnabled ? await databaseBytes(prisma) : null;
  return {
    mode: writeEnabled ? 'WRITE' : 'DRY_RUN',
    filter: {
      location_id: options.locationId,
      created_after: options.startDate,
      created_before: options.endDate,
      expected_total: options.expectedTotal,
    },
    ...stats,
    raw_json_stored: false,
    staging_rows_created: 0,
    database_size_before_bytes: beforeBytes,
    database_size_after_bytes: afterBytes,
    database_growth_bytes:
      beforeBytes === null || afterBytes === null ? null : afterBytes - beforeBytes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const unknownArguments = args.filter(
    (argument) =>
      argument !== WRITE_FLAG &&
      argument !== '--dry-run' &&
      !['--location=', '--year=', '--expected-total=', '--max-database-mb='].some(
        (prefix) => argument.startsWith(prefix),
      ),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Argumen tidak dikenal: ${unknownArguments.join(', ')}`);
  }
  const writeEnabled = args.includes(WRITE_FLAG);
  if (writeEnabled && args.includes('--dry-run')) {
    throw new Error(`${WRITE_FLAG} tidak boleh digabung dengan --dry-run`);
  }

  const options = parseOptions(args);
  console.log(
    `Customer import location=${options.locationId}, periode=[${options.startDate}, ${options.endDate}), ` +
      `mode=${writeEnabled ? 'WRITE' : 'DRY_RUN'}`,
  );
  const result = await runImport(options, writeEnabled);
  console.log('\n=== HASIL IMPORT ===');
  console.log(JSON.stringify(result, null, 2));
  if (!writeEnabled) {
    console.log(`\nDRY-RUN selesai. Tambahkan ${WRITE_FLAG} jika hasil di atas benar.`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`\nImport customer gagal: ${error.response?.data?.message || error.message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  mapCustomer,
  normalizePhone,
  parseOptions,
  runImport,
};
