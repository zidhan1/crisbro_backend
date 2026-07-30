// Refresh saldo poin customer dari Runchise.
//
// Menyegarkan seluruh outlet lewat API membutuhkan ribuan request sekuensial
// (29 outlet, paginasi 100 baris per halaman), jauh di atas batas waktu fungsi
// serverless. Karena itu jalur API penuh dijalankan sebagai script CLI, sama
// seperti importRunchiseLocationCustomers.js, sedangkan cron memakai jalur
// staging yang selesai dalam satu query.
//
// Pemakaian:
//   node scripts/syncCustomerPoints.js --check         # diagnostik, TIDAK menulis
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
  inspectCustomerPointSources,
} = require('../src/services/syncService');

/**
 * Membaca argumen command line menjadi mode eksekusi. Argumen --from-staging
 * memilih jalur staging; argumen angka positif membatasi sync ke satu outlet.
 * Argumen angka yang tidak valid dianggap kesalahan agar typo tidak diam-diam
 * berubah menjadi sync seluruh outlet yang jauh lebih lama.
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--check')) return { check: true };
  if (args.includes('--from-staging')) return { fromStaging: true };

  const positional = args.find((arg) => !arg.startsWith('--'));
  if (positional === undefined) return { fromStaging: false, locationId: null };

  const locationId = Number(positional);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new Error(`location_id tidak valid: ${positional}`);
  }

  return { fromStaging: false, locationId };
}

/**
 * Menampilkan hasil diagnostik beserta kesimpulannya. divergent_customers
 * adalah penentunya: nilai nol berarti setiap outlet melaporkan poin yang sama
 * untuk customer yang sama, sehingga penggabungan "outlet terakhir menang" pada
 * jalur API tidak kehilangan data. Nilai di atas nol berarti sebaliknya.
 */
function reportCheck(report) {
  const { staging, divergence, merge_strategies, stored_now } = report;

  console.log('\n=== TABEL STAGING (RunchiseLocationCustomer) ===');
  console.log(`Baris                     : ${staging.staging_rows}`);
  console.log(`Customer unik             : ${staging.unique_customers}`);
  console.log(`Impor terakhir            : ${staging.last_import_at ?? '-'}`);

  console.log('\n=== POIN BERBEDA ANTAR OUTLET? ===');
  console.log(`Customer di >1 outlet     : ${divergence.multi_outlet_customers}`);
  console.log(`Poinnya berbeda           : ${divergence.divergent_customers}`);
  console.log(`Total selisih (max-min)   : ${divergence.total_point_spread}`);

  console.log('\n=== HASIL PER STRATEGI MERGE (customer ber-akun) ===');
  console.log(`Customer tercocokkan      : ${merge_strategies.matched_customers}`);
  console.log(`Punya poin > 0            : ${merge_strategies.customers_with_points}`);
  console.log(`total_point bila MAX      : ${merge_strategies.total_if_max}`);
  console.log(`total_point bila SUM      : ${merge_strategies.total_if_sum}`);
  console.log(`available bila MAX        : ${merge_strategies.available_if_max}`);
  console.log(`available bila SUM        : ${merge_strategies.available_if_sum}`);

  console.log('\n=== NILAI TERSIMPAN SEKARANG (CustomerPoint) ===');
  console.log(`Baris                     : ${stored_now.point_rows}`);
  console.log(`Punya poin > 0            : ${stored_now.customers_with_points}`);
  console.log(`SUM total_point           : ${stored_now.total_point}`);
  console.log(`SUM available_point       : ${stored_now.available_point}`);
  console.log(`Update terakhir           : ${stored_now.last_updated_at ?? '-'}`);

  console.log('\n=== KESIMPULAN ===');

  // Ambang materialitas. Divergensi nol sulit terjadi di praktik karena snapshot
  // tiap outlet diambil pada waktu berbeda, jadi sedikit selisih adalah skew
  // waktu, bukan bukti poin per outlet. Yang menentukan adalah proporsinya.
  const divergentShare =
    divergence.multi_outlet_customers > 0
      ? divergence.divergent_customers / divergence.multi_outlet_customers
      : 0;
  const MATERIAL_DIVERGENT_SHARE = 0.01;

  if (divergence.multi_outlet_customers === 0) {
    console.log(
      'Tidak ada customer di lebih dari satu outlet pada data staging, sehingga',
    );
    console.log(
      'pertanyaan global-vs-per-outlet belum dapat dijawab. Segarkan staging dulu',
    );
    console.log('dengan `npm run import:runchise-customers <locationId>`.');
  } else if (divergentShare <= MATERIAL_DIVERGENT_SHARE) {
    const percent = (divergentShare * 100).toFixed(2);
    console.log(
      `Poin BERSIFAT GLOBAL per customer. Hanya ${divergence.divergent_customers} dari`,
    );
    console.log(
      `${divergence.multi_outlet_customers} customer multi-outlet yang berbeda (${percent}%), dengan total`,
    );
    console.log(
      `selisih ${divergence.total_point_spread} poin. Skala itu konsisten dengan perbedaan waktu`,
    );
    console.log('snapshot antar outlet, bukan saldo yang benar-benar per outlet.');
    console.log(
      '\nPenggabungan lintas outlet pada jalur API aman: MAX/snapshot terbaru benar,',
    );
    console.log('dan SUM akan menggelembungkan saldo.');
  } else {
    const percent = (divergentShare * 100).toFixed(2);
    console.log(
      `Poin BERBEDA ANTAR OUTLET untuk ${divergence.divergent_customers} customer (${percent}%).`,
    );
    console.log(
      'Proporsi ini terlalu besar untuk dijelaskan oleh skew waktu snapshot.',
    );
    console.log(
      'Strategi merge pada jalur API perlu ditinjau sebelum dipakai lagi.',
    );
  }

  // SUM selalu melebihi MAX begitu ada customer berpoin yang terdaftar di lebih
  // dari satu outlet, terlepas dari ada tidaknya divergensi. Ditegaskan agar
  // selisih kedua kolom tidak salah dibaca sebagai poin yang hilang.
  const sumInflation = merge_strategies.total_if_sum - merge_strategies.total_if_max;
  if (sumInflation > 0) {
    console.log(
      `\nSUM melebihi MAX sebanyak ${sumInflation} poin. Itu efek customer berpoin yang`,
    );
    console.log(
      'terdaftar di beberapa outlet dan ikut terhitung berulang, bukan poin hilang.',
    );
  }

  // Penjelasan sebenarnya di balik total poin yang terasa kecil.
  if (merge_strategies.matched_customers > 0) {
    const withPoints = merge_strategies.customers_with_points;
    const share = (
      (withPoints / merge_strategies.matched_customers) *
      100
    ).toFixed(1);
    const average = withPoints > 0
      ? (merge_strategies.total_if_max / withPoints).toFixed(1)
      : '0';

    console.log(
      `\nPartisipasi: ${withPoints} dari ${merge_strategies.matched_customers} customer (${share}%) punya poin,`,
    );
    console.log(
      `rata-rata ${average} poin per pemilik poin. Inilah sebab total terlihat kecil,`,
    );
    console.log('bukan karena poin hilang saat sync.');
  }

  const storedVsMax = stored_now.total_point - merge_strategies.total_if_max;
  if (storedVsMax !== 0) {
    console.log(
      `\nCatatan: nilai tersimpan berbeda ${storedVsMax} dari strategi MAX atas staging.`,
    );
    console.log(
      'Selisih wajar bila staging dan sync API diambil pada waktu berbeda.',
    );
  }
}

async function main() {
  const { check, fromStaging, locationId } = parseArgs(process.argv);

  if (check) {
    console.log('Menjalankan diagnostik read-only (tidak ada penulisan)...');
    reportCheck(await inspectCustomerPointSources());
    return;
  }

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
