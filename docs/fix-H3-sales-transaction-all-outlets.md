# H-3 (HIGH) — Cron sinkronisasi sales-transaction hanya mencakup satu outlet atau nol

Status: **Fixed**

File terdampak:

- `src/jobs/runchiseSyncCron.js`
- `src/services/syncService.js`
- `src/lib/salesTransactionSyncCoverage.js`
- `test/salesTransactionSyncCoverage.test.js`
- `package.json`

Kategori: **Reliabilitas, Correctness, Coverage**

## 1. Masalah

Sebelum perbaikan, cron sinkronisasi laporan sales mengambil satu
`locationId` dari environment variable `RUNCHISE_SYNC_LOCATION_ID`, kemudian
meneruskannya ke `syncSalesTransactionReports()`:

```js
async function runSyncSalesTransactionReportsJob() {
  const { locationId } = getSyncConfig();
  return syncSalesTransactionReports(locationId);
}
```

Service hanya dapat memproses satu outlet. Jika `locationId` tidak tersedia
atau tidak valid, fungsi tidak melakukan sinkronisasi dan mengembalikan hasil
`skipped`:

```js
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
```

Akibatnya terdapat dua skenario kegagalan:

1. `RUNCHISE_SYNC_LOCATION_ID` kosong atau tidak valid: cron selesai dengan
   `skipped: true` dan tidak menyimpan satu transaksi pun.
2. `RUNCHISE_SYNC_LOCATION_ID` berisi satu outlet: hanya outlet itu yang
   diproses. Jika terdapat 29 outlet, laporan dari 28 outlet lainnya tidak
   pernah masuk ke database melalui cron ini.

Jalur sinkronisasi customer sudah mengambil seluruh outlet melalui
`getRunchiseSyncLocationIds()`, tetapi pola yang sama belum diterapkan pada
sales transaction.

## 2. Dampak

Data pada `CustomerSalesTransactionReport` menjadi tidak lengkap secara
permanen selama cron hanya memproses satu outlet. Dampak turunannya meliputi:

- histori penambahan dan penggunaan poin dari outlet lain tidak tersimpan;
- laporan penjualan per outlet tidak mencerminkan seluruh jaringan;
- ringkasan loyalty dapat menampilkan jumlah transaksi, penggunaan poin, dan
  tren yang lebih rendah daripada kondisi sebenarnya;
- outlet yang hilang tidak terlihat sebagai kegagalan karena job satu outlet
  tetap dapat menghasilkan status sukses;
- environment variable kosong menghasilkan nol baris tanpa error yang dapat
  ditangkap monitoring.

Ini merupakan masalah correctness, bukan hanya optimasi: sistem menghasilkan
ringkasan yang valid secara format tetapi salah secara coverage.

## 3. Kondisi sebelum perbaikan

### 3.1 Cron dibatasi oleh satu environment variable

```text
RUNCHISE_SYNC_LOCATION_ID=101
                         │
                         ▼
runSyncSalesTransactionReportsJob()
                         │
                         ▼
syncSalesTransactionReports(101)
                         │
                         ▼
Hanya outlet 101 tersinkron
```

Dengan contoh 29 outlet:

```text
Outlet ditemukan     : 29
Outlet diproses cron : 1
Outlet tidak diproses: 28
Coverage             : 1/29
```

### 3.2 Environment variable kosong

```text
RUNCHISE_SYNC_LOCATION_ID tidak diisi
                         │
                         ▼
locationId = null
                         │
                         ▼
{ skipped: true, synced: 0, total: 0 }
```

Job tidak melempar error, sehingga scheduler atau monitoring dapat menganggap
eksekusi selesai normal walaupun coverage-nya nol.

### 3.3 Contoh output lama

Ketika env kosong:

```json
{
  "skipped": true,
  "reason": "RUNCHISE_SYNC_LOCATION_ID belum diisi dengan ID outlet Runchise yang valid",
  "synced": 0,
  "skipped_rows": 0,
  "total": 0
}
```

Ketika env berisi satu outlet, output hanya menggambarkan transaksi outlet
tersebut dan tidak menyertakan metrik jumlah outlet:

```json
{
  "synced": 42,
  "total": 50,
  "skipped": 0,
  "skipped_zero_points": 8,
  "deleted_zero_points": 0
}
```

Output tersebut tidak bisa membedakan “seluruh outlet sudah selesai” dari
“hanya satu outlet yang pernah dijalankan”.

## 4. Perbaikan

### 4.1 Cron tidak lagi meneruskan satu locationId

Cron sekarang memanggil service tanpa `locationId`:

```js
const result = await syncSalesTransactionReports();
```

Pemanggilan tanpa ID memiliki arti eksplisit: sinkronkan seluruh outlet yang
tersedia.

`RUNCHISE_SYNC_LOCATION_ID` tidak lagi membatasi coverage cron. Nilai tersebut
hanya menjadi fallback di `getRunchiseSyncLocationIds()` jika daftar lokasi
tidak dapat diperoleh dari API Runchise.

### 4.2 Service mengambil seluruh outlet

`syncSalesTransactionReports()` sekarang memiliki dua mode:

```js
const targetLocationId = parseRunchiseId(locationId);
const locationIds = targetLocationId
  ? [targetLocationId]
  : await getRunchiseSyncLocationIds();
```

| Pemanggilan | Perilaku |
|---|---|
| `syncSalesTransactionReports()` | Mengambil dan memproses seluruh outlet |
| `syncSalesTransactionReports(101)` | Memproses outlet 101 saja untuk operasi manual/diagnostik |
| `syncSalesTransactionReports('invalid')` | Fail-fast dengan error validasi |

Mode satu outlet tetap dipertahankan agar endpoint manual, proses backfill
terbatas, dan diagnostik tidak kehilangan kompatibilitas.

### 4.3 Sinkronisasi dilakukan secara sekuensial

Outlet diproses satu per satu, bukan dengan `Promise.all`:

```text
Outlet 101 selesai
       │
       ▼
Outlet 202 selesai/gagal
       │
       ▼
Outlet 303 selesai
       │
       ▼
Ringkasan coverage
```

Satu outlet dapat memuat banyak halaman sales dan customer. Menjalankan semua
outlet secara paralel berisiko:

- menembus rate limit API Runchise;
- menggunakan terlalu banyak koneksi database;
- meningkatkan penggunaan memori proses cron;
- membuat kegagalan sementara terjadi pada banyak outlet sekaligus.

Eksekusi sekuensial mengutamakan stabilitas dan memastikan beban tetap
terkontrol.

### 4.4 Kegagalan parsial tidak menghentikan outlet lain

Agregasi multi-outlet dipisahkan ke
`src/lib/salesTransactionSyncCoverage.js`. Jika satu outlet gagal:

- error outlet dicatat bersama `location_id`;
- counter `locations_failed` bertambah;
- outlet berikutnya tetap diproses;
- status akhir menjadi `completed_with_errors`;
- detail kegagalan tersedia pada array `failures` untuk monitoring dan retry.

Dengan demikian, timeout satu outlet tidak menghilangkan data dari 28 outlet
lainnya.

### 4.5 Kegagalan total tidak lagi dianggap sukses

Jika seluruh outlet gagal, agregator melempar error dan menyertakan
`syncSummary`:

```js
if (summary.locations_completed === 0) {
  const error = new Error(
    `Sinkronisasi sales gagal untuk seluruh ${summary.locations_total} outlet`,
  );
  error.syncSummary = summary;
  throw error;
}
```

Handler cron dapat menangkap error tersebut, mencatat scheduled run sebagai
gagal, dan memicu alert/retry. Tidak ada lagi hasil nol baris yang diam-diam
dilaporkan sebagai `skipped` normal.

### 4.6 locationId eksplisit divalidasi

Nilai `locationId` yang diberikan secara eksplisit tetapi tidak valid ditolak:

```text
locationId harus berupa ID outlet Runchise yang valid
```

Validasi ini mencegah typo pada endpoint/manual job berubah secara tidak
sengaja menjadi sinkronisasi seluruh outlet yang jauh lebih berat.

## 5. Alur setelah perbaikan

```text
Cron sales dimulai
       │
       ▼
syncSalesTransactionReports() tanpa locationId
       │
       ▼
getRunchiseSyncLocationIds()
       │
       ├── Daftar API tersedia ──► gunakan seluruh ID outlet unik dan valid
       │
       └── Daftar kosong ────────► gunakan RUNCHISE_SYNC_LOCATION_ID sebagai fallback
                                      atau throw bila fallback tidak valid
       │
       ▼
Proses setiap outlet secara sekuensial
       │
       ├── Sukses ──► agregasi synced/total/skipped
       │
       └── Gagal ───► catat failure dan lanjut ke outlet berikutnya
       │
       ▼
Hasil akhir
       ├── Semua sukses  ─► completed
       ├── Sebagian gagal ─► completed_with_errors
       └── Semua gagal   ─► throw error + syncSummary
```

## 6. Output setelah perbaikan

### 6.1 Seluruh outlet berhasil

Contoh berikut bersifat ilustratif untuk 29 outlet:

```json
{
  "status": "completed",
  "locations_total": 29,
  "locations_completed": 29,
  "locations_failed": 0,
  "synced": 1450,
  "total": 1600,
  "skipped": 3,
  "skipped_zero_points": 147,
  "deleted_zero_points": 2,
  "results": [
    {
      "location_id": 101,
      "synced": 42,
      "total": 50,
      "skipped": 0,
      "skipped_zero_points": 8,
      "deleted_zero_points": 0
    }
  ],
  "failures": []
}
```

`results` berisi satu entry untuk setiap outlet yang berhasil. Hanya satu entry
ditampilkan pada contoh agar ringkas.

### 6.2 Sebagian outlet gagal

```json
{
  "status": "completed_with_errors",
  "locations_total": 29,
  "locations_completed": 28,
  "locations_failed": 1,
  "synced": 1408,
  "total": 1550,
  "skipped": 3,
  "skipped_zero_points": 139,
  "deleted_zero_points": 2,
  "results": [],
  "failures": [
    {
      "location_id": 202,
      "error": "API timeout"
    }
  ]
}
```

Cron juga menulis warning terukur:

```text
[runchise-sync:sales] completed with 1/29 outlet failed
```

### 6.3 Seluruh outlet gagal

Job melempar error:

```text
Sinkronisasi sales gagal untuk seluruh 29 outlet
```

Error membawa ringkasan:

```json
{
  "status": "failed",
  "locations_total": 29,
  "locations_completed": 0,
  "locations_failed": 29,
  "synced": 0,
  "failures": [
    {
      "location_id": 101,
      "error": "upstream unavailable"
    }
  ]
}
```

Angka 29 dan nilai transaksi pada contoh output adalah ilustrasi berdasarkan
skenario issue, bukan hasil eksekusi terhadap production.

## 7. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Sumber outlet cron | Satu `RUNCHISE_SYNC_LOCATION_ID` | Seluruh hasil `getRunchiseSyncLocationIds()` |
| Env lokasi kosong | `skipped: true`, nol baris | Ambil daftar outlet; throw bila daftar dan fallback tidak tersedia |
| Coverage dengan 29 outlet | Maksimum 1/29 | Ditargetkan 29/29 |
| Metrik coverage | Tidak ada | Total, completed, dan failed per outlet |
| Kegagalan satu outlet | Job gagal/berhenti pada satu target | Dicatat; outlet berikutnya tetap berjalan |
| Seluruh outlet gagal | Bisa terlihat sebagai skip normal | Error dilempar ke handler cron/monitoring |
| Beban API | Satu outlet | Semua outlet secara sekuensial |
| Mode manual satu outlet | Ada | Tetap tersedia |
| ID eksplisit tidak valid | Menghasilkan skip | Ditolak fail-fast |

## 8. Verifikasi

Pengujian dilakukan tanpa memanggil API Runchise dan tanpa menulis ke database
production. Agregator diberi fungsi sinkronisasi tiruan agar orchestration dan
coverage dapat diuji secara deterministik.

### 8.1 Unit test

```text
$ npm test

ok 1 - mengiterasi dan mengagregasi seluruh outlet secara sekuensial
ok 2 - kegagalan satu outlet tidak menghentikan sinkronisasi outlet lain
ok 3 - melempar error terukur bila seluruh outlet gagal

tests 3
pass 3
fail 0
cancelled 0
skipped 0
```

Kasus yang dibuktikan:

1. Semua ID outlet dipanggil tepat sesuai urutan.
2. Maksimum sinkronisasi aktif pada satu waktu adalah satu.
3. Nilai `synced` dan `total` diagregasi dari seluruh outlet.
4. Kegagalan outlet tengah tidak mencegah outlet setelahnya diproses.
5. Detail outlet gagal disimpan pada `failures`.
6. Kegagalan seluruh outlet menghasilkan exception dengan `syncSummary`.

### 8.2 Pemeriksaan sintaks

```text
node --check src/services/syncService.js
node --check src/jobs/runchiseSyncCron.js
node --check src/lib/salesTransactionSyncCoverage.js

Exit code: 0
```

### 8.3 Pemeriksaan diff

```text
git diff --check

Exit code: 0
```

Sinkronisasi live tidak dijalankan sebagai bagian dari verifikasi otomatis
karena proses tersebut akan memanggil API eksternal dan menulis laporan ke
database. Pengujian staging tetap diperlukan sebelum rollout production.

## 9. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Iterasi `getRunchiseSyncLocationIds()` untuk sales | `syncSalesTransactionReports()` memanggil helper tersebut ketika tidak diberi ID eksplisit |
| Samakan coverage dengan sync customer | Cron tidak lagi membatasi sales ke environment variable satu outlet |
| Hindari nol baris saat env kosong | Daftar outlet diambil dari API; ketiadaan seluruh sumber lokasi menjadi error |
| Buat hasil terukur | Output menyediakan `locations_total`, `locations_completed`, `locations_failed`, `results`, dan `failures` |
| Jaga stabilitas saat banyak outlet | Outlet diproses sekuensial dan kegagalan parsial diisolasi |
| Pertahankan operasi satu outlet | `locationId` eksplisit tetap memproses satu outlet untuk manual/diagnostik |

## 10. Yang tidak berubah

- Mapping satu transaksi sales ke `CustomerSalesTransactionReport` tidak
  diubah.
- Composite identity tetap memakai pasangan `source_location_id` dan
  `runchise_sales_transaction_id`.
- Transaksi tanpa penambahan maupun penggunaan poin tetap tidak disimpan.
- Data lama yang berubah menjadi nol poin tetap dibersihkan melalui
  `deleteMany` seperti sebelumnya.
- Parameter periode, status, dan payment method tetap diteruskan ke setiap
  outlet.
- Mutex `salesRunning` tetap mencegah dua cron sales berjalan bersamaan pada
  proses Node yang sama.
- Endpoint/manual sync masih dapat membatasi pekerjaan ke satu outlet.

## 11. Risiko residual dan tindak lanjut

- Memproses seluruh outlet membutuhkan waktu lebih lama daripada satu outlet.
  Implementasi sekuensial mengendalikan beban, tetapi durasi aktual harus
  dipantau pada staging/production.
- Mutex `salesRunning` hanya berlaku di dalam satu proses. Dua instance
  serverless berbeda masih dapat menjalankan job bersamaan. Distributed lock
  atau job table dapat ditambahkan jika deployment memungkinkan overlap antar
  instance.
- Kegagalan parsial dicatat tetapi belum memiliki retry per-outlet otomatis di
  dalam run yang sama. Array `failures` menyediakan ID yang dibutuhkan untuk
  retry terarah.
- Jika API daftar lokasi hanya mengembalikan subset outlet, coverage mengikuti
  daftar tersebut. Monitoring harus membandingkan `locations_total` dengan
  jumlah outlet yang diharapkan.
- Untuk jumlah data yang sangat besar, checkpoint/cursor per outlet seperti
  customer import dapat menjadi peningkatan lanjutan agar aman terhadap batas
  waktu serverless.

## 12. Checklist deployment dan monitoring

1. Deploy perubahan service dan cron secara bersamaan.
2. Jalankan sinkronisasi pada staging dan periksa `locations_total` terhadap
   jumlah outlet aktif yang diharapkan.
3. Pastikan `locations_completed + locations_failed = locations_total`.
4. Periksa bahwa `source_location_id` pada data baru mencakup semua outlet.
5. Bandingkan jumlah laporan/ringkasan loyalty sebelum dan sesudah backfill.
6. Buat alert bila `status` bukan `completed`, `locations_failed > 0`, atau
   `locations_total` lebih kecil dari baseline outlet.
7. Jalankan backfill periode historis untuk outlet yang sebelumnya tidak pernah
   tersinkron; perbaikan cron hanya menjamin run berikutnya dan tidak otomatis
   memastikan seluruh periode historis sudah terisi.
