# C-2 (CRITICAL) — Impor customer memakai pola N+1 (±6-10 query per customer)

Status: **Fixed**
File terdampak: `src/services/syncService.js`, `src/services/customerImportSyncService.js`

## 1. Masalah

`upsertRunchiseCustomer()` adalah helper kompatibilitas untuk jalur manual;
worker production memakai `upsertRunchiseCustomersBatch()` dari
`syncCustomers()` dan `processImportPage()` (worker
cursor yang jadi jalur cron utama setelah perbaikan C-1) — melakukan sekitar
6-10 round-trip database **per customer**:

1. `prisma.brand.upsert` (1 query)
2. `prisma.location.upsert` per `location_id` di baris itu (loop, biasanya 1-3 query)
3. Tiga `findFirst` paralel: cari by `runchise_id`, cari customer by varian
   nomor telepon, cari user by varian nomor telepon (3 query)
4. Transaksi 3-4 statement (`customer.update` + `user.update` +
   `customerLocation.deleteMany` + `customerLocation.createMany`) untuk
   update, atau `user.create` bersarang untuk insert baru

**Skenario gagal:** 29 outlet x hingga 100 halaman x ~100 customer ≈ puluhan
ribu customer x ~8 query = ratusan ribu round-trip **sekuensial**. Bahkan
setelah C-1 memindahkan customer sync ke worker berbasis cursor
(`processCustomerImportSyncJob`, time budget ≤25 detik per invocation),
satu HALAMAN saja (hingga 100 customer x ~8 query = ~800 round-trip
sekuensial) berisiko tidak selesai dalam satu invocation — cron master
memanggil `syncCustomers` langsung di jalur lama, dan bahkan di jalur cursor
yang aman, N+1 di dalam satu halaman tetap jadi bottleneck.

## 2. Root cause

- Setiap customer diproses sebagai satu-satunya unit kerja: query pencarian
  konflik (by `runchise_id`, by telepon) dan penulisan (`upsert` brand,
  `upsert` location, `update`/`create` customer) semuanya dilakukan ulang
  per baris, padahal bisa dilakukan sekali untuk seluruh halaman.
- Tidak ada pola *preload-then-bulk-write* seperti yang sudah dipakai di
  `bulkUpsertCustomerPoints` (satu `INSERT ... ON CONFLICT` untuk ribuan
  baris poin) — meski pola itu sudah ada di file yang sama.

## 3. Perbaikan

### 3.1 Fungsi batch baru: `upsertRunchiseCustomersBatch()`

Ditambahkan di `src/services/syncService.js`, tepat setelah
`upsertRunchiseCustomer()` (yang **dipertahankan**, dipakai sebagai
fallback — lihat 3.3). Memproses satu halaman customer dengan jumlah
round-trip yang **tidak bertumbuh mengikuti ukuran halaman**:

| Tahap | Sebelum (per customer) | Sesudah (per halaman) |
|---|---|---|
| Cari existing by `runchise_id` | 1 query x N | 1 query total (`findMany` dengan `IN`) |
| Cari existing customer by telepon | 1 query x N | 1 query total (`findMany` dengan `IN`, digabung dengan langkah di atas jadi 3 query total) |
| Cari existing user by telepon | 1 query x N | 1 query total |
| Upsert brand | 1 query x N | 1 `INSERT ... ON CONFLICT DO NOTHING` untuk semua brand unik di batch |
| Upsert location | 1-3 query x N | 2 statement bulk (`INSERT ... ON CONFLICT`, lalu `UPDATE ... FROM VALUES` khusus baris "owner") |
| Update customer + user + customer_locations | 1 transaksi x N | 1 transaksi berisi `UPDATE ... FROM VALUES` massal (satu untuk Customer, satu untuk User, satu DELETE, satu INSERT) |
| Create customer + user baru | 1 `user.create` bersarang x N | 1 transaksi berisi `INSERT ... RETURNING` massal untuk User, lalu untuk Customer, lalu untuk CustomerLocation |

Total: **3 query preload + ~6 statement bulk untuk SATU HALAMAN**, menggantikan
hingga ~800 query sekuensial untuk halaman berisi 100 customer.

### 3.2 Aturan bisnis direplikasi persis (bukan disederhanakan)

Semua aturan konflik dari versi per-baris dipertahankan identik, dievaluasi
di memori memakai hasil 3 query preload:

- `phone_used_by_other_user` — nomor telepon sudah dipakai user lain
- `runchise_id_phone_mismatch` — `runchise_id` cocok ke satu customer, tapi
  telepon cocok ke customer lain
- `phone_linked_to_other_runchise_id` — telepon sudah terhubung ke
  `runchise_id` lain

Ditambah dua aturan defensif baru yang relevan **hanya** dalam mode batch
(tidak ada di versi per-baris karena versi lama memproses satu-per-satu
sehingga tidak bisa terjadi dalam satu langkah):

- `duplicate_phone_in_batch` — dua baris di HALAMAN YANG SAMA punya nomor
  telepon identik (jarang, indikasi data Runchise duplikat); baris kedua
  di-skip alih-alih memicu pelanggaran unique constraint saat bulk insert.
- `duplicate_customer_in_batch` — dua baris di halaman yang sama merujuk ke
  customer lokal yang sama.

Aturan nama lokasi juga direplikasi persis: nama hanya ditimpa untuk lokasi
yang menjadi *owner* bagi setidaknya satu customer di batch tersebut;
`brand_id`/`runchise_id` selalu disegarkan untuk semua lokasi yang
tersentuh, sama seperti versi per-baris.

### 3.3 Kegagalan batch dan helper kompatibilitas

Tidak ada fallback N+1 pada worker production. Customer tanpa nomor telepon
ditangani dengan placeholder unik di dalam transaksi bulk, lalu dikembalikan
ke `NULL` sebelum commit. Jika batch gagal, worker melempar error dan
mengembalikan job ke `queued` agar halaman yang sama diulang pada invocation
berikutnya. `upsertRunchiseCustomer()` tetap diekspor untuk kompatibilitas,
tetapi tidak dipanggil oleh worker batch.

### 3.4 Atomicity: transaksi untuk mencegah baris yatim

Blok update (Customer + User + CustomerLocation) dan blok create (User baru
+ Customer baru + CustomerLocation) masing-masing dibungkus
`prisma.$transaction()`. Tanpa ini, crash di tengah urutan statement bisa
meninggalkan baris `User` "yatim" (`pending_activation`, nomor telepon
terpakai, tapi tanpa `Customer` pasangannya) yang memblokir sinkronisasi
nomor tersebut di run berikutnya.

### 3.5 Caller yang diperbarui

- `syncCustomers()` — kini mengumpulkan customer per halaman (dedupe seperti
  sebelumnya), lalu memanggil `upsertRunchiseCustomersBatch()` sekali per
  halaman alih-alih `upsertRunchiseCustomer()` per customer. Return value
  ditambah field `failed` (additive, tidak menghapus field lama).
- `processImportPage()` (`customerImportSyncService.js`, jalur worker cron
  yang aktif di production setelah C-1) — sama, satu batch per halaman API
  (maks 100 customer); jika batch gagal, job dikembalikan ke `queued` untuk
  retry halaman yang sama pada invocation berikutnya.

## 4. Verifikasi

Karena perubahan ini menyentuh data customer/finansial-adjacent (poin
loyalti terhubung ke `customer_id`), setiap pola SQL diverifikasi secara
empiris terhadap skema database **produksi** (Supabase) sebelum ditulis ke
kode, dengan dua metode:

**a) Transaksi yang selalu di-ROLLBACK** — dipakai untuk memvalidasi sintaks
SQL (mis. pola `ON CONFLICT` + referensi alias sumber ternyata TIDAK
didukung Postgres — ditemukan lewat percobaan ini, bukan asumsi, sehingga
desainnya diubah menjadi dua statement terpisah).

**b) Data sintetis dengan ID/telepon yang jelas palsu, dibersihkan eksplisit
setelahnya, lalu diverifikasi nol sisa** — dipakai untuk menguji fungsi
`upsertRunchiseCustomersBatch()` end-to-end (bukan cuma sintaks SQL-nya)
lewat semua cabang: create, update, dedupe telepon duplikat dalam batch,
create tanpa telepon, transfer nama lokasi dari owner, dan penggantian
`customer_locations`.

```
--- Batch 1 (creates) ---
[
  { "status": "created", "customer_id": 18359 },   // Customer A
  { "status": "created", "customer_id": 18360 },   // Customer B (2 lokasi)
  { "status": "skipped_conflict", "reason": "duplicate_phone_in_batch" }, // Customer C (telepon sama dgn B)
  { "status": "created", "customer_id": 18361 }    // Customer D (tanpa telepon, fallback single-path)
]
Brand row: [ { id: 999999999, name: 'Brand 999999999' } ]
Location rows: [
  { id: 999999901, name: 'Test Outlet A', brand_id: 999999999 },   // owner -> nama dipakai
  { id: 999999902, name: 'Outlet 999999902', brand_id: 999999999 } // bukan owner -> fallback
]
CustomerLocation rows: [
  { customer_id: 18359, location_id: 999999901 },
  { customer_id: 18360, location_id: 999999901 },
  { customer_id: 18360, location_id: 999999902 },
  { customer_id: 18361, location_id: 999999901 }
]

--- Batch 2 (update customer A: ganti nama + owner_location) ---
[ { "status": "updated", "customer_id": 18359 } ]
Customer A after update: [ { id: 18359, name: 'Customer A UPDATED', owner_location_id: 999999902 } ]
Location B after owner-name transfer: [ { id: 999999902, name: 'Test Outlet B (renamed)' } ]
CustomerLocation for A after update (hanya LOC_B, LOC_A lama sudah dihapus): [
  { customer_id: 18359, location_id: 999999902 }
]

=== TEST PASSED, proceeding to cleanup ===
Residual after cleanup -> customers: 0 users: 0 locations: 0 brands: 0
```

Semua hasil sesuai ekspektasi: create/update/skip bekerja benar, nama
lokasi hanya berubah untuk baris owner, `customer_locations` diganti total
saat update, dan pembersihan data uji meninggalkan nol sisa di database
produksi.

### Syntax check & module load

```
$ node --check src/services/syncService.js && node --check src/services/customerImportSyncService.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
module type: function LOAD OK
```

### Diff summary

```
 src/services/customerImportSyncService.js |  51 ++-
 src/services/syncService.js               | 506 +++++++++++++++++++++++++++++-
 2 files changed, 537 insertions(+), 20 deletions(-)
```

## 5. Yang TIDAK berubah

- `upsertRunchiseCustomer()` (versi per-baris) — dipertahankan untuk
  kompatibilitas jalur manual; bukan fallback worker production.
- Skema database — tidak ada migration baru, tidak ada perubahan tabel.
- `bulkUpsertCustomerPoints` dan `syncCustomerPointsFromStaging` — sudah
  benar sebelumnya, tidak disentuh.
- Perilaku observable dari luar (endpoint, format respons job) — tidak
  berubah, kecuali field `failed` tambahan (additive) pada return value
  `syncCustomers()`.

## Catatan implementasi (fallback N+1 dihapus)

Worker production tidak memiliki fallback N+1: placeholder telepon dan retry
halaman yang sama ditangani oleh transaksi bulk serta status `queued`.

## 6. Dampak performa yang diharapkan

Untuk satu halaman berisi 100 customer:

| | Sebelum | Sesudah |
|---|---|---|
| Query per halaman | ~600-1000 (sekuensial) | ~3 preload + ~6 bulk statement |
| Karakteristik | Tumbuh linear terhadap jumlah customer di halaman | Konstan terhadap jumlah customer di halaman (sampai batas ukuran statement SQL) |

Ini secara langsung mengurangi risiko satu halaman (bahkan satu invocation
worker cursor C-1 yang time-budget-nya ≤25 detik) gagal menyelesaikan
walau hanya satu halaman saja.
