# C-1 (CRITICAL) — Master sync job menjalankan 6 tahap berat berurutan dalam satu invocation

> Pembaruan: tahap customer kini dipisahkan menjadi enqueue harian
> `/api/cron/runchise-sync/customers` (`15 12 * * *`) dan worker yang hanya
> melanjutkan job aktif di `/api/cron/runchise-sync/customers-worker`
> (`*/10 * * * *`). Worker tidak membuat full-import baru saat idle dan
> keduanya berhenti hanya saat `RUNCHISE_CUSTOMER_SYNC_ENABLED=false`;
> konfigurasi yang tidak diisi tetap aktif.

Status: **Fixed**
File terdampak: `src/jobs/runchiseSyncCron.js`, `src/index.js`, `vercel.json`, `README.md`

## 1. Masalah

`runRunchiseMasterSyncJob()` menjalankan enam tahap sinkronisasi Runchise
secara berurutan dengan `await` di dalam satu invocation function:

```
syncLocations → syncBrands → syncProducts → runCustomerSyncJob (syncCustomers penuh)
  → syncSalesTransactionReports → syncPromos
```

Tiap tahap melakukan paginasi penuh ke API Runchise + penulisan N+1 ke DB.
Total pekerjaan jauh melampaui batas eksekusi function Vercel (10 detik pada
plan Hobby, sampai puluhan detik pada plan lain karena `vercel.json` tidak
menyetel `maxDuration`).

**Skenario gagal:** function di-kill di tengah jalan oleh Vercel. Karena
tidak ada checkpoint per-tahap, semua tahap setelah titik kill diam-diam
tidak pernah berjalan — tidak ada log error, tidak ada retry, tidak ada
penanda "tahap X gagal". Sinkronisasi harian secara praktis tidak pernah
selesai, dan operator tidak punya cara mengetahuinya tanpa membaca log satu
per satu.

Endpoint ini dipanggil oleh cron Vercel `/api/cron/runchise-sync/master`
(`vercel.json`, jadwal lama `0 12 * * *`), jadi masalah ini terjadi di setiap
run harian di production.

## 2. Root cause

- Enam operasi berat dirangkai dalam satu request/invocation, bukan
  dipecah menjadi unit kerja independen.
- Tidak ada checkpoint/cursor per tahap — kegagalan di tahap ke-N
  menghanguskan progres tahap 1..N-1 secara *reporting* (hasil tahap
  sebelumnya sudah tersimpan di DB, tapi tahap setelahnya tidak pernah
  tereksekusi dan tidak ada catatan bahwa itu terjadi) dan tidak
  meninggalkan jejak yang jelas.
- Sinkronisasi customer di dalam chain memakai `syncCustomers()` (impor
  penuh lewat API, 29 outlet x N halaman) padahal codebase sudah punya pola
  worker berbasis cursor yang aman untuk serverless
  (`customerImportSyncService.js`, dipakai dashboard admin), tetapi cron
  tidak memanfaatkannya.

## 3. Perbaikan

### 3.1 Pecah satu job raksasa menjadi 6 job independen

`src/jobs/runchiseSyncCron.js` — `runRunchiseMasterSyncJob()` dihapus,
diganti 6 fungsi job independen, masing-masing dengan mutex
(`*Running` flag) dan logging sendiri:

| Fungsi | Menggantikan tahap |
|---|---|
| `runSyncLocationsJob()` | `syncLocations` |
| `runSyncBrandsJob()` | `syncBrands` |
| `runSyncProductsJob()` | `syncProducts` |
| `runCustomerImportWorkerJob()` | `runCustomerSyncJob` (customer) — **diganti** ke worker cursor |
| `runSyncSalesTransactionReportsJob()` | `syncSalesTransactionReports` |
| `runSyncPromosJob()` | `syncPromos` |

Tiap fungsi independen: kegagalan atau timeout pada satu tahap tidak lagi
memengaruhi tahap lain, dan setiap tahap memiliki log
`[runchise-sync:<tahap>] started/finished` sendiri untuk observability.

`runCustomerSyncJob()` (impor penuh via `syncCustomers`) **dipertahankan**
tapi **tidak lagi dijadwalkan cron manapun** — hanya untuk dipanggil manual
lewat CLI/script saat operator butuh refresh penuh, karena inilah tahap yang
sebelumnya paling sering menyebabkan timeout (29 outlet x N halaman API).

### 3.2 Customer sync memakai worker berbasis cursor yang sudah ada

`runCustomerImportWorkerJob()` (baru) menggantikan peran customer di dalam
chain lama. Ia memanggil pola yang sudah ada di
`customerImportSyncService.js` (dipakai juga oleh dashboard admin):

1. `createCustomerImportSyncJob({ source: 'cron' })` — membuat baris job
   baru di tabel `CustomerImportSyncJob` hanya jika tidak ada job
   `queued`/`running` aktif (idempoten).
2. `processCustomerImportSyncJob()` — memproses beberapa halaman API dalam
   *time budget* efektif 20 detik (reserve runtime tetap dijaga), hingga
   **20 halaman** sebagai batas keselamatan, lalu **menyimpan
   cursor** (`current_location_index`, `current_page`) ke DB dan return.

Invocation berikutnya (baik dari cron terjadwal atau proses idle-callback)
melanjutkan dari cursor tersimpan, bukan mengulang dari outlet pertama. Job
yang terpotong oleh timeout tetap bisa dilanjutkan karena statusnya kembali
ke `queued` (baris `finally`/catch di `customerImportSyncService.js`), dan
advisory lock Postgres mencegah dua invocation berjalan bersamaan.

### 3.3 Endpoint cron dipecah satu-per-tahap

`src/index.js` — endpoint `/api/cron/runchise-sync/master` **dihapus** dan
diganti respons `410 Gone` yang mengarahkan ke endpoint baru (mencegah
kegagalan senyap bila ada pemanggil lama yang tersisa). Endpoint baru:

```
GET|POST /api/cron/runchise-sync/locations
GET|POST /api/cron/runchise-sync/brands
GET|POST /api/cron/runchise-sync/products
GET|POST /api/cron/runchise-sync/customers          (worker berbasis cursor)
GET|POST /api/cron/runchise-sync/sales-transactions
GET|POST /api/cron/runchise-sync/promos
GET|POST /api/cron/runchise-sync/points              (sudah ada, tidak berubah)
GET|POST /api/cron/runchise-sync/customer-timestamps-worker  (manual/worker aplikasi)
```

Semua tetap dilindungi `requireCronSecret` (header `Authorization: Bearer`
atau `x-cron-secret`), sama seperti sebelumnya.

### 3.4 Jadwal cron Vercel

`vercel.json` — satu cron per tahap, digeser 5 menit agar tidak
tumpang-tindih dan tidak membebani DB secara bersamaan. Customer sync
diantrikan sekali sehari (`15 12 * * *`), sedangkan worker cursor berjalan
setiap 10 menit (`*/10 * * * *`) agar backlog selesai bertahap tanpa risiko
timeout:

| Endpoint | Jadwal lama | Jadwal baru |
|---|---|---|
| locations | (bagian dari master, 12:00) | `0 12 * * *` |
| brands | (bagian dari master, 12:00) | `5 12 * * *` |
| products | (bagian dari master, 12:00) | `10 12 * * *` |
| customers enqueue | (bagian dari master, 12:00) | `15 12 * * *` |
| customers worker | (bagian dari master, 12:00) | `*/10 * * * *` |
| sales-transactions | (bagian dari master, 12:00) | `20 12 * * *` |
| promos | (bagian dari master, 12:00) | `25 12 * * *` |
| points | `15 12 * * *` | `30 12 * * *` |
| customer-timestamps-worker | `30 12 * * *` | tidak dijadwalkan Vercel |
| maintenance | `45 12 * * *` | `45 12 * * *` (tidak berubah) |
| ~~master~~ | `0 12 * * *` | **dihapus** |

### 3.5 Scheduler in-process (non-serverless) diselaraskan

`startRunchiseSyncCron()` (dipakai hanya saat proses berjalan persisten,
bukan lewat Vercel) sebelumnya juga memanggil job raksasa di startup.
Sekarang setiap tahap dijadwalkan dan dijalankan-saat-start secara
independen (fire-and-forget per tahap), dengan jadwal masing-masing bisa
dikonfigurasi lewat env var baru: `RUNCHISE_LOCATIONS_SYNC_CRON`,
`RUNCHISE_BRANDS_SYNC_CRON`, `RUNCHISE_PRODUCTS_SYNC_CRON`,
`RUNCHISE_CUSTOMERS_IMPORT_SYNC_CRON`, `RUNCHISE_SALES_SYNC_CRON`,
`RUNCHISE_PROMOS_SYNC_CRON`, `RUNCHISE_POINTS_SYNC_CRON`.

## 4. Output verifikasi setelah perbaikan

### 4.1 Syntax check

```
$ node --check src/jobs/runchiseSyncCron.js && node --check src/index.js && echo "SYNTAX OK"
SYNTAX OK
```

### 4.2 Module load (memastikan tidak ada error saat require, semua route/handler valid)

```
$ node -e "
  process.env.DATABASE_URL='postgres://user:pass@localhost:5432/db';
  process.env.JWT_SECRET='test-secret';
  process.env.RUNCHISE_SYNC_CRON_ENABLED='false';
  const app = require('./src/index.js');
  console.log('module type:', typeof app, 'LOAD OK');
"
module type: function LOAD OK
```

### 4.3 Referensi lama sudah bersih

```
$ grep -rn "runRunchiseMasterSyncJob" src/ vercel.json README.md
(tidak ada hasil — seluruh referensi ke job lama sudah dihapus)
```

### 4.4 Diff summary

```
 README.md                    |  33 ++++-
 src/index.js                 |  89 ++++++++++++--
 src/jobs/runchiseSyncCron.js | 286 +++++++++++++++++++++++++++++++++++--------
 vercel.json                  |  26 +++-
 4 files changed, 366 insertions(+), 68 deletions(-)
```

## 5. Yang TIDAK berubah

- `syncCustomerPointsFromStaging` (job points) — tetap satu query DB,
  sudah aman untuk serverless, tidak disentuh.
- `processCustomerTimestampSyncJob` (job customer-timestamps) — sudah
  memakai pola cursor sebelumnya, tidak disentuh.
- `/admin/sync/*` (trigger manual dari dashboard admin) — tidak disentuh,
  tetap memakai `createCustomerImportSyncJob` + `processCustomerImportSyncJob`
  yang sama.
- Skema database — tidak ada migration baru, tidak ada perubahan tabel.

## 6. Catatan deploy

- Perubahan `vercel.json` (daftar `crons`) baru aktif setelah **deploy ke
  production**; Vercel membaca cron config dari deployment yang sedang live.
- Pastikan `CRON_SECRET` tetap terisi di
  environment production — tanpa itu semua endpoint `/api/cron/*` akan
  menolak request cron Vercel (lihat `requireCronSecret` di `src/index.js`).
- Jika ada monitoring/alerting eksternal yang memanggil
  `/api/cron/runchise-sync/master` secara langsung (di luar `vercel.json`),
  update ke endpoint baru — endpoint lama sekarang mengembalikan `410 Gone`
  dengan pesan yang menunjuk endpoint pengganti, bukan 404 tanpa penjelasan.
