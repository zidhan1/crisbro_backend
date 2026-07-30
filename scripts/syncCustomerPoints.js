// Refresh saldo poin customer dari Runchise.
//
// Menyegarkan seluruh outlet lewat API membutuhkan ribuan request sekuensial
// (29 outlet, paginasi 100 baris per halaman), jauh di atas batas waktu fungsi
// serverless. Karena itu jalur API penuh dijalankan sebagai script CLI, sama
// seperti importRunchiseLocationCustomers.js, sedangkan cron memakai jalur
// staging yang selesai dalam satu query.
//
// Pemakaian:
//   node scripts/syncCustomerPoints.js                 # semua outlet, via API
//   node scripts/syncCustomerPoints.js --from-staging  # semua outlet, via staging
//   node scripts/syncCustomerPoints.js 4453            # satu outlet, via API

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = require('../src/lib/prisma');
const {
  syncCustomerPoints,
  syncCustomerPointsFromStaging,
} = require('../src/services/syncService');

/**
 * Membaca argumen command line menjadi mode eksekusi. Argumen --from-staging
 * memilih jalur staging; argumen angka positif membatasi sync ke satu outlet.
 * Argumen angka yang tidak valid dianggap kesalahan agar typo tidak diam-diam
 * berubah menjadi sync seluruh outlet yang jauh lebih lama.
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--from-staging')) return { fromStaging: true };

  const positional = args.find((arg) => !arg.startsWith('--'));
  if (positional === undefined) return { fromStaging: false, locationId: null };

  const locationId = Number(positional);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new Error(`location_id tidak valid: ${positional}`);
  }

  return { fromStaging: false, locationId };
}

async function main() {
  const { fromStaging, locationId } = parseArgs(process.argv);

  if (fromStaging) {
    console.log('Menurunkan saldo poin dari tabel staging...');
    const result = await syncCustomerPointsFromStaging();
    console.log(JSON.stringify(result, null, 2));

    if (result.divergent_customers > 0) {
      console.warn(
        `\nPERINGATAN: ${result.divergent_customers} customer memiliki poin berbeda antar outlet.`,
      );
      console.warn(
        'Poin diasumsikan global per customer. Bila angka ini di atas nol,',
      );
      console.warn(
        'poin Runchise ternyata per outlet dan strategi merge harus ditinjau.',
      );
    }

    return;
  }

  console.log(
    locationId
      ? `Menyegarkan saldo poin outlet ${locationId} dari API Runchise...`
      : 'Menyegarkan saldo poin SELURUH outlet dari API Runchise (butuh beberapa menit)...',
  );

  const result = await syncCustomerPoints({ locationId });
  console.log(JSON.stringify(result, null, 2));
}

// Guard wajib: tanpa ini sekadar require() dari file lain akan langsung
// menjalankan sync penuh ke API Runchise.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        `\nSync poin gagal: ${error.response?.data?.message || error.message}`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = { parseArgs };
