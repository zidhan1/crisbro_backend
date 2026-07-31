const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../src/lib/prisma');
const { fetchAllLocations } = require('../src/services/runchiseService');

const TARGET_BRAND_RUNCHISE_ID = 750;
const DEFAULT_EXPECTED_COUNT = 32;
const WRITE_FLAG = '--confirm-db-write';

function printHelp() {
  console.log(`
Import locations Runchise secara minimal dan terukur.

Penggunaan:
  npm run import:selected-locations
  npm run import:selected-locations -- --confirm-db-write
  npm run import:selected-locations -- --expected-count=32

Pengamanan:
  - Default adalah dry-run.
  - Hanya locations milik brand Runchise ${TARGET_BRAND_RUNCHISE_ID} yang diproses.
  - Jumlah hasil harus sama dengan expected-count (default ${DEFAULT_EXPECTED_COUNT}).
  - Nested settings, sub-brands, opening hours, dan raw JSON tidak disimpan.
  - Tidak ada location yang dihapus otomatis.
`);
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function optionalText(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function coordinate(value, minimum, maximum, label, locationId) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} location ${locationId} tidak valid: ${value}`);
  }
  return parsed;
}

function normalizePhone(value, countryCode = 62) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const code = String(countryCode || 62).replace(/\D/g, '') || '62';
  if (digits.startsWith(code)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${code}${digits.slice(1)}`;
  return `+${code}${digits}`;
}

function parseExpectedCount(args) {
  const argument = args.find((item) => item.startsWith('--expected-count='));
  if (!argument) return DEFAULT_EXPECTED_COUNT;
  const count = positiveInt(argument.slice('--expected-count='.length));
  if (!count) throw new Error('--expected-count harus berupa integer positif');
  return count;
}

function selectLocations(apiLocations, expectedCount) {
  if (!Array.isArray(apiLocations)) {
    throw new Error('Response Runchise tidak memiliki array locations');
  }

  const selected = apiLocations.filter(
    (location) => Number(location?.brand_id) === TARGET_BRAND_RUNCHISE_ID,
  );
  if (selected.length !== expectedCount) {
    throw new Error(
      `Jumlah location brand ${TARGET_BRAND_RUNCHISE_ID} adalah ${selected.length}; ` +
        `expected ${expectedCount}. Import dibatalkan agar response parsial/perubahan API tidak tertulis.`,
    );
  }

  const seenIds = new Set();
  const mapped = selected.map((location) => {
    const runchiseId = positiveInt(location?.id);
    const name = optionalText(location?.name);
    if (!runchiseId || !name) throw new Error('Location memiliki id/nama yang tidak valid');
    if (seenIds.has(runchiseId)) throw new Error(`Location duplikat: ${runchiseId}`);
    seenIds.add(runchiseId);

    const branchType = optionalText(location.branch_type)?.toLowerCase() ?? null;
    const status = optionalText(location.status)?.toLowerCase() ?? null;
    return {
      runchise_id: runchiseId,
      name,
      address: optionalText(location.shipping_address),
      city: optionalText(location.city),
      province: optionalText(location.province),
      phone: normalizePhone(location.contact_number, location.contact_number_country_code),
      latitude: coordinate(location.latitude, -90, 90, 'latitude', runchiseId),
      longitude: coordinate(location.longitude, -180, 180, 'longitude', runchiseId),
      is_active: status === 'activated' && location.deleted !== true,
      is_outlet: branchType === 'outlet',
    };
  });

  return mapped.sort((left, right) => left.runchise_id - right.runchise_id);
}

function buildPreview(locations, writeEnabled) {
  return {
    mode: writeEnabled ? 'WRITE' : 'DRY_RUN',
    target_brand_runchise_id: TARGET_BRAND_RUNCHISE_ID,
    totals: {
      selected: locations.length,
      active: locations.filter((item) => item.is_active).length,
      inactive: locations.filter((item) => !item.is_active).length,
      outlets: locations.filter((item) => item.is_outlet).length,
      non_outlets: locations.filter((item) => !item.is_outlet).length,
    },
    locations,
    deliberately_skipped: [
      'opening_hour',
      'central_kitchens',
      'central_kitchen_ids',
      'sub_brands',
      'delivery_settings',
      'pos_settings',
      'integration_settings',
      'raw_json',
    ],
  };
}

async function databaseBytes(db) {
  const rows = await db.$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  return Number(rows[0]?.bytes ?? 0);
}

async function importSelectedLocations(locations) {
  const beforeBytes = await databaseBytes(prisma);
  const result = await prisma.$transaction(async (tx) => {
    const brand = await tx.brand.findUnique({
      where: { runchise_id: TARGET_BRAND_RUNCHISE_ID },
      select: { id: true, name: true },
    });
    if (!brand) {
      throw new Error(
        `Brand Runchise ${TARGET_BRAND_RUNCHISE_ID} belum ada. Jalankan import sub-brand terlebih dahulu.`,
      );
    }

    const ids = locations.map((item) => item.runchise_id);
    const existingRows = await tx.location.findMany({
      where: { OR: [{ runchise_id: { in: ids } }, { id: { in: ids } }] },
      select: { id: true, runchise_id: true },
    });
    const byRunchiseId = new Map();
    const byLocalId = new Map(existingRows.map((item) => [item.id, item]));
    for (const row of existingRows) {
      if (row.runchise_id == null) continue;
      if (byRunchiseId.has(row.runchise_id)) {
        throw new Error(`Database memiliki runchise_id location duplikat: ${row.runchise_id}`);
      }
      byRunchiseId.set(row.runchise_id, row);
    }

    let inserted = 0;
    let updated = 0;
    for (const location of locations) {
      const runchiseMatch = byRunchiseId.get(location.runchise_id);
      const localIdMatch = byLocalId.get(location.runchise_id);
      if (runchiseMatch && localIdMatch && runchiseMatch.id !== localIdMatch.id) {
        throw new Error(`Konflik ID location Runchise ${location.runchise_id}`);
      }

      const existing = runchiseMatch ?? localIdMatch;
      const data = { brand_id: brand.id, ...location };
      if (existing) {
        await tx.location.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await tx.location.create({ data: { id: location.runchise_id, ...data } });
        inserted++;
      }
    }

    const verified = await tx.location.count({
      where: { runchise_id: { in: ids }, brand_id: brand.id },
    });
    if (verified !== locations.length) {
      throw new Error(`Verifikasi transaksi gagal: tersimpan ${verified}/${locations.length}`);
    }

    return {
      brand: { id: brand.id, runchise_id: TARGET_BRAND_RUNCHISE_ID, name: brand.name },
      locations_inserted: inserted,
      locations_updated: updated,
      locations_verified: verified,
    };
  });
  const afterBytes = await databaseBytes(prisma);

  return {
    ...result,
    database_size_before_bytes: beforeBytes,
    database_size_after_bytes: afterBytes,
    database_growth_bytes: afterBytes - beforeBytes,
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
      !argument.startsWith('--expected-count='),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Argumen tidak dikenal: ${unknownArguments.join(', ')}`);
  }
  const writeEnabled = args.includes(WRITE_FLAG);
  if (writeEnabled && args.includes('--dry-run')) {
    throw new Error(`${WRITE_FLAG} tidak boleh digabung dengan --dry-run`);
  }

  const expectedCount = parseExpectedCount(args);
  console.log(`Mengambil locations Runchise; brand=${TARGET_BRAND_RUNCHISE_ID}, expected=${expectedCount}`);
  const apiLocations = await fetchAllLocations();
  const locations = selectLocations(apiLocations, expectedCount);
  const preview = buildPreview(locations, writeEnabled);
  console.log('\n=== RENCANA IMPORT ===');
  console.log(JSON.stringify(preview, null, 2));

  if (!writeEnabled) {
    console.log(`\nDRY-RUN selesai. Tambahkan ${WRITE_FLAG} jika data di atas sudah benar.`);
    return preview;
  }

  const result = await importSelectedLocations(locations);
  console.log('\n=== IMPORT SELESAI ===');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`\nImport locations gagal: ${error.response?.data?.message || error.message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  DEFAULT_EXPECTED_COUNT,
  TARGET_BRAND_RUNCHISE_ID,
  buildPreview,
  importSelectedLocations,
  normalizePhone,
  parseExpectedCount,
  selectLocations,
};
