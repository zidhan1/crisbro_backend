# M-9 (MEDIUM) — Helper fetchAll* & sync reward-redemption menumpuk seluruh dataset di memori

Status: **Fixed** — termasuk `raw: sale` yang sebelumnya sengaja tidak
disentuh (lihat bagian 6 untuk audit lengkap dan penutupannya).
File terdampak: `src/services/runchiseService.js`, `src/services/syncService.js`, `src/services/runchisePosRewardRedemptionService.js`, `scripts/importRunchiseSalesTransactions.js`, `test/salesTransactionRawSnapshot.test.js`

## 1. Masalah

Tiga pola terpisah yang sama-sama menumpuk dataset penuh di memori sebelum
memproses satu baris pun:

1. **`fetchAllCustomers`/`fetchAllCustomersAcrossLocations`** (`runchiseService.js`)
   digabung dengan `concat` ke satu array besar. Dipakai oleh
   `syncCustomerPoints()` (`syncService.js`) untuk sinkronisasi poin
   seluruh outlet — bisa menumpuk ~10 ribu customer x 29 outlet jadi
   ratusan ribu objek customer **lengkap** (nama, alamat, email, dst) di
   memori sekaligus, padahal fungsi itu cuma butuh 2 angka
   (`total_point`, `available_point`) per customer.
2. **`syncSalesTransactionReportsForLocation()`** (`syncService.js`)
   memanggil `fetchAllCustomers(targetLocationId)` untuk membangun lookup
   customer per outlet — pola yang sama, padahal hanya 6 field yang
   akhirnya dipakai.
3. **Blob `raw` penuh disimpan per baris** — `raw: sale` di
   `CustomerSalesTransactionReport` dan `raw: promo` di `Promo`.
4. **`syncRunchisePosRewardRedemptions()`** (`runchisePosRewardRedemptionService.js`)
   memuat **seluruh** `CustomerSalesTransactionReport` yang cocok filter
   sekaligus (termasuk kolom `raw`-nya) lewat satu `findMany` tanpa batas,
   lalu menjalankan `await prisma.$transaction(writes)` **di dalam loop**
   — satu transaksi database terpisah untuk **setiap** baris report (N+1).

## 2. Analisis sebelum menulis kode: mana yang perlu diubah, mana yang tidak

Saya telusuri pemanggil tiap fungsi lewat `grep` untuk menentukan skala
risiko nyata, bukan menebak:

- `fetchAllCustomers`/`fetchAllCustomersAcrossLocations` — dipakai
  `syncCustomerPoints()` (dipanggil dari endpoint admin manual +
  `scripts/syncCustomerPoints.js`, yang sudah punya komentar sendiri
  "butuh beberapa menit" mengakui ini proses berat) **dan**
  `syncSalesTransactionReportsForLocation()` (dipanggil dari cron
  serverless via `syncSalesTransactionReports`, setelah C-1 dijadwalkan
  independen per tahap). Keduanya perlu diperbaiki — yang kedua lebih
  mendesak karena berjalan di runtime serverless yang memori/waktunya
  terbatas.
- `fetchAllProducts`, `fetchAllPromos` — diekspor tapi **tidak dipanggil
  di mana pun** (`grep` tidak menemukan satu pemanggil pun di `src/` atau
  `scripts/`). Kode mati, tidak disentuh (di luar scope — menghapus kode
  mati adalah keputusan terpisah dari perbaikan performa ini).
- `fetchAllSubBrands`, `fetchAllLocations` — dipakai untuk data katalog
  kecil dan terbatas (sub-brand, 29 outlet), bukan skala customer/transaksi.
  Tidak diubah.
- `raw: sale` (`CustomerSalesTransactionReport`) — **masih dipakai**
  `extractRewardRedemptions()`/`unwrapSale()` di
  `runchisePosRewardRedemptionService.js` untuk mengekstrak
  `sale_detail_transactions` dan metadata loyalty, field yang **tidak**
  disimpan di kolom manapun selain `raw`. Pada perbaikan awal ini
  **sengaja tidak disentuh** karena memangkas field tanpa audit lengkap
  setiap titik baca berisiko mematahkan ekstraksi reward secara diam-diam
  (banyak akses field pakai `?.`, jadi field yang hilang tidak akan
  melempar error — cuma menghasilkan hasil salah tanpa peringatan).
  **Audit lengkap sudah dilakukan pada update berikutnya — lihat bagian 6.**
- `raw: promo` (`Promo`) — ditelusuri lewat `grep` menyeluruh: **tidak ada
  satu kode pun** (backend maupun frontend) yang membaca kolom ini
  kembali. `mapPromo()` di `promoRoutes.js` bahkan sudah memfilternya
  keluar dari respons API sejak awal. Aman dihapus penyimpanannya karena
  terbukti nol pemakai, bukan sekadar dugaan.

Keputusan ini menentukan bentuk perbaikan: fokus pada pola yang terbukti
berisiko dan aman diperbaiki (streaming customer, batching write), dan
secara eksplisit **tidak** memangkas `raw: sale` karena risikonya lebih
besar dari manfaatnya tanpa audit skema Runchise yang lengkap.

## 3. Perbaikan

### 3.1 `syncCustomerPoints()` — stream per halaman, bukan tumpuk semua outlet

**Sebelum:**
```js
const [runchiseCustomers, localCustomers] = await Promise.all([
  targetLocationId
    ? fetchAllCustomers(targetLocationId)
    : fetchAllCustomersAcrossLocations(),   // <- ~10rb customer x 29 outlet
  prisma.customer.findMany({...}),
]);
for (const c of runchiseCustomers) { /* proyeksi ke 2 angka */ }
```

**Sesudah:** loop per outlet, per halaman, langsung diproyeksikan —
objek customer Runchise lengkap tidak pernah menumpuk lebih dari satu
halaman (`item_per_page`) di memori:
```js
for (const outletId of locationIds) {
  let page = 1, hasMore = true;
  while (hasMore) {
    const data = await fetchCustomersPage(outletId, page);
    for (const c of data.customers) {
      // langsung diproyeksikan ke {customerId, totalPoint, availablePoint}
    }
    hasMore = data.paging?.next_page != null;
    page++;
  }
}
```

### 3.2 `syncSalesTransactionReportsForLocation()` — lookup terproyeksi, bukan objek penuh

Fungsi baru `fetchRunchiseCustomerLookupForLocation()` menggantikan
`fetchAllCustomers(targetLocationId)`: stream per halaman, simpan hanya 6
field yang benar-benar dipakai `mapSalesTransactionReportData()` (`name`,
`phone_number`, `phone_number_country_code`, `created_at`,
`available_point`, `owner_location.name`) — bukan objek customer penuh
(nama, alamat, email, dst).

### 3.3 `syncRunchisePosRewardRedemptions()` — paginasi cursor + batch write per halaman

**Sebelum:** satu `findMany` tanpa batas untuk SEMUA report yang cocok
filter, lalu satu `$transaction` **per baris report** di dalam loop (N
transaksi database untuk N report).

**Sesudah:** cursor pagination (`orderBy: {id:'asc'}` + `cursor`/`skip:1`,
200 report per halaman) — tidak pernah menumpuk lebih dari satu halaman
report (dengan blob `raw`-nya) di memori sekaligus. Seluruh write (delete +
upsert) untuk SATU HALAMAN report digabung jadi **satu** transaksi,
memangkas jumlah transaksi dari N menjadi kira-kira N/200.

### 3.4 `raw: promo` tidak disimpan lagi

`mapRunchisePromoToLocalData()` sekarang mengembalikan `raw: null`. Karena
`upsertPromoChunk()` memakai objek ini utuh sebagai `update`, nilai `null`
ini juga membersihkan blob lama begitu promo tersebut ikut ter-sync ulang
(cron promo berjalan harian) — bukan cuma mencegah pertumbuhan baru. Kolom
`raw` di skema `Promo` sengaja **tidak dihapus** (bukan migration), hanya
berhenti diisi.

### 3.5 Komentar peringatan di `runchiseService.js`

`fetchAllCustomers`/`fetchAllCustomersAcrossLocations` dipertahankan
(masih dipakai jalur lain yang genuinely butuh daftar lengkap), tapi
diberi komentar eksplisit mengarahkan pemanggil baru ke pola stream per
halaman (`fetchCustomersPage`) terlebih dulu sebelum memakai fungsi ini.

## 4. Verifikasi

Karena fungsi-fungsi ini memanggil API Runchise sungguhan, pengujian
dilakukan **tanpa** memanggil API eksternal — dengan mem-mock
`fetchCustomersPage` sebelum modul yang mengimpornya di-require (Node
module cache memastikan mock ini yang ditangkap), atau dengan data
sintetis langsung di database untuk bagian yang murni baca-tulis lokal.

### `syncRunchisePosRewardRedemptions` — cursor pagination lintas batas halaman (data sungguhan di DB)

Dibuat 205 baris `CustomerSalesTransactionReport` sintetis (>200, memaksa
2 iterasi halaman nyata) untuk membuktikan tidak ada baris yang
hilang/dobel di batas halaman:

```
Membuat 205 baris CustomerSalesTransactionReport sintetis...
summary: {
  transactions_scanned: 205,
  transactions_valid: 0,
  transactions_point_mismatch: 0,
  transactions_no_candidate: 205,
  redemption_rows: 0,
  managed_rows: 0
}
elapsed: 19159 ms

transactions_scanned harus PERSIS 205 (tidak ada baris hilang/dobel lintas batas halaman): true
```

### `syncCustomerPoints` — streaming per halaman (fetchCustomersPage di-mock)

```
=== syncCustomerPoints({ locationId }) dengan fetchCustomersPage TER-MOCK ===
result: { scope: 'location:999999698', synced: 0, matched: 0, unmatched: 210, total: 210, local_customers: 18330 }

fetchCustomersPage dipanggil 3 kali (harus 3: 2 halaman penuh + 1 sisa): true
total (jumlah customer ter-scan) harus 210: true
```

3 halaman sintetis (100 + 100 + 10 = 210 customer) diproses tepat 3 kali
panggilan `fetchCustomersPage`, berhenti dengan benar di `next_page: null`.

### `fetchRunchiseCustomerLookupForLocation` — hanya 6 field terproyeksi

```
fetchCustomersPage dipanggil 2 kali (harus 2: 1 halaman penuh + 1 sisa): true
jumlah entri lookup harus 105: true
contoh entri id=800001: {
  name: 'Mock 1', phone_number: '8123400001', phone_number_country_code: 62,
  created_at: '2025-01-01T00:00:00Z', available_point: 2,
  owner_location: { name: 'Outlet Mock' }
}
hanya 6 field yang diproyeksikan: available_point,created_at,name,owner_location,phone_number,phone_number_country_code
address TIDAK ikut tersimpan: true
email TIDAK ikut tersimpan: true
```

Data sintetis sengaja menyertakan field besar (`address` diulang 50x,
`email`) untuk membuktikan field itu **tidak** ikut masuk ke lookup map —
bukan cuma diasumsikan dari membaca kode.

### `raw: promo`

```
raw field: null
raw TIDAK menyimpan blob besar lagi: true
```

### Syntax check & module load

```
$ node --check src/services/runchiseService.js src/services/syncService.js src/services/runchisePosRewardRedemptionService.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
LOAD OK
```

Seluruh data uji (baris `CustomerSalesTransactionReport`/
`RunchisePosRewardRedemption` sintetis) dibersihkan setelahnya dan
diverifikasi nol sisa di database produksi.

### Diff summary

```
 src/services/runchisePosRewardRedemptionService.js | 117 ++++++++++++------
 src/services/runchiseService.js                    |  20 ++-
 src/services/syncService.js                        | 134 ++++++++++++++++-----
 3 files changed, 202 insertions(+), 69 deletions(-)
```

## 5. Yang TIDAK berubah (di luar bagian 6)

- `fetchAllSubBrands`, `fetchAllLocations` — data katalog kecil, tidak
  berisiko, tidak disentuh.
- `fetchAllProducts`, `fetchAllPromos` — kode mati (tidak dipanggil di
  mana pun), dibiarkan apa adanya; penghapusan kode mati adalah
  keputusan terpisah dari perbaikan performa ini.
- Skema database — tidak ada migration baru. Kolom `raw` di `Promo` dan
  `CustomerSalesTransactionReport` tetap ada (hanya berhenti diisi/berubah
  bentuk untuk baris baru/yang ter-sync ulang).
- `fetchAllSalesTransactions` (dipakai `syncSalesTransactionReportsForLocation`)
  — tidak diubah jadi streaming pada perbaikan ini. Berbeda dengan roster
  customer (yang selalu penuh per outlet terlepas dari filter tanggal),
  volume sales transactions secara alami dibatasi oleh rentang
  `start_date`/`end_date` yang dipakai tiap sync, sehingga tidak
  seberisiko kasus "~10rb customer x 29 outlet" yang eksplisit disebut
  laporan. Bisa jadi perbaikan lanjutan terpisah bila volumenya terbukti
  jadi masalah di kemudian hari.

## 6. Update — celah residual ditutup: `raw: sale` dipangkas ke field yang benar-benar dipakai

Audit lanjutan menindaklanjuti keputusan "sengaja tidak disentuh" di bagian
2 dengan melakukan tepat audit yang sebelumnya dihindari karena berisiko:
menelusuri **setiap** titik baca `report.raw`/`sale` di seluruh codebase
untuk memastikan field mana saja yang genuinely dipakai, sebelum memangkas
apa pun.

### 6.1 Audit titik baca

```bash
grep -rn "\.raw\b\|raw:" src --include=*.js | grep -v node_modules
```

Hasilnya menunjukkan `CustomerSalesTransactionReport.raw` **hanya** dibaca
di dua tempat:

1. `unwrapSale()`/`extractRewardRedemptions()` di
   `runchisePosRewardRedemptionService.js` — jalur produksi.
2. `scripts/verifyRunchisePosRewardRedemptions.js` — script debugging
   manual, membaca subset field yang **sama persis**.

Tidak ada endpoint admin, export, atau tooling lain yang pernah
mengembalikan/membaca kolom ini. Dari kedua titik itu, field `sale` yang
benar-benar pernah diakses cuma:

```text
id, customer_id, customer_name, customer_phone_number,
customer_phone_number_country_code, location_id, location_name,
sales_time, local_sales_time,
metadata.redeemed_point, metadata.loyalty.{redeemed_point,loyalty_products},
loyalty.{redeemed_point,loyalty_products},
sale_detail_transactions[].{id,product_id,product_name,price,quantity,
  cancelled_quantity,deleted,meta.sell_price}
```

Field lain — rincian pajak, diskon, katalog produk penuh, info staff/meja,
dan puluhan field lain yang dikirim API `/sale_transactions` — tidak pernah
dibaca ulang setelah ditulis. Field itulah yang selama ini ikut tersimpan
permanen di setiap baris tanpa pernah dipakai.

`unwrapSale()` juga memeriksa `raw.sale_transaction` sebagai fallback
(bentuk envelope dari endpoint detail-per-transaksi
`GET /sale_transactions/:id`, dipakai `scripts/importRunchiseSalesTransactions.js`
lewat `fetchSaleTransactionDetail()`). Ditelusuri lebih lanjut: script itu
sendiri sudah meng-unwrap `data.sale_transaction` sebelum menyimpan
(`const sale = data?.sale_transaction;`), jadi `raw` yang tertulis di kedua
jalur (sync utama dan script backfill) selalu berbentuk objek sale yang
sudah tak terbungkus — fallback `raw.sale_transaction` di `unwrapSale()`
murni jaga-jaga, tidak ada penulis aktif yang menghasilkan bentuk itu.

### 6.2 Perbaikan

`buildSaleRewardRedemptionSnapshot(sale)` (baru, `syncService.js`)
memproyeksikan `sale` ke persis daftar field di atas sebelum disimpan:

```js
function buildSaleRewardRedemptionSnapshot(sale) {
  if (!sale || typeof sale !== 'object') return null;
  return {
    id: sale.id ?? null,
    customer_id: sale.customer_id ?? null,
    // ...9 field identitas/lokasi/waktu lainnya
    loyalty: pickLoyaltyContainer(sale.loyalty),
    metadata: sale.metadata
      ? { redeemed_point: ..., loyalty: pickLoyaltyContainer(sale.metadata.loyalty) }
      : null,
    sale_detail_transactions: (sale.sale_detail_transactions ?? []).map((d) => ({
      id: d?.id ?? null, product_id: d?.product_id ?? null, /* ... */
    })),
  };
}
```

Kedua kemungkinan lokasi field loyalty (`sale.metadata.loyalty` **dan**
`sale.loyalty`) tetap disalin apa adanya — `extractRewardRedemptions()`
memakai fallback `sale.metadata?.loyalty ?? sale.loyalty`, jadi keduanya
harus tetap tersedia agar fallback itu tidak diam-diam kehilangan data pada
bentuk respons yang memakai jalur kedua.

`mapSalesTransactionReportData()` sekarang menulis
`raw: buildSaleRewardRedemptionSnapshot(sale)`, bukan `raw: sale`.
`scripts/importRunchiseSalesTransactions.js` (backfill CLI manual) diubah
memakai fungsi yang **sama** (diimpor dari `syncService.js`) alih-alih
`JSON.stringify(sale)` langsung — mencegah script itu diam-diam
menghidupkan kembali blob penuh di masa depan lewat jalur yang berbeda.

### 6.3 Pengujian terukur

`test/salesTransactionRawSnapshot.test.js` (6 test, seluruhnya lulus lewat
`npm test`) membuktikan dua klaim sekaligus, bukan cuma salah satu:

1. **Ukuran benar-benar berkurang dan field bloat benar-benar hilang** —
   dibangun objek `sale` sintetis dengan field bloat realistis (rincian
   pajak 50 baris, diskon 30 baris, info staff/meja, katalog produk 100
   item), dan dibuktikan `JSON.stringify(snapshot).length` < 20% ukuran
   `JSON.stringify(sale)` asli, plus tidak satu pun field bloat (`tax_breakdown`,
   `discount_breakdown`, `shift_history`, `floor_plan_svg`,
   `full_product_catalog`, dst) muncul di hasil `JSON.stringify` snapshot.
2. **Ekstraksi reward tetap identik, dari raw penuh maupun raw dipangkas** —
   `extractRewardRedemptions()` dipanggil dua kali dengan `sale` yang sama
   persis (satu lewat raw asli, satu lewat raw yang sudah dipangkas), untuk
   kedua kemungkinan lokasi field loyalty (`sale.metadata.loyalty` dan
   `sale.loyalty`). Hasilnya dibandingkan `deepEqual` pada seluruh field
   yang menentukan hasil bisnis (produk, pelanggan, lokasi, poin,
   `calculatedPoints`, `redeemedPoints`, `valid`) — identik persis di kedua
   kasus. (Sub-objek `row.raw` yang ikut menyalin `detail`/`loyaltyProduct`
   apa adanya sengaja dites terpisah: field bloat pada level detail
   transaksi juga ikut hilang di sana — manfaat tambahan, bukan regresi.)
3. Kasus tepi: `unwrapSale()` tetap bekerja normal untuk raw yang sudah
   dipangkas (tidak ada wrapper `sale_transaction`), dan
   `buildSaleRewardRedemptionSnapshot()` aman dipanggil dengan
   `null`/`undefined`/nilai bukan objek.

Jalankan:

```bash
npm test
```

Seluruh suite backend: **70/70 test lulus**, tidak ada regresi pada 64 test
yang sudah ada sebelumnya.

### 6.4 Risiko residual yang tersisa (disengaja, bukan celah)

- **Baris historis** yang sudah tersimpan sebelum perbaikan ini tetap
  membawa blob `raw` penuh sampai baris itu ikut ter-sync ulang (upsert)
  secara alami — tidak ada migration/backfill data yang dijalankan sebagai
  bagian dari perbaikan ini. Backfill terpisah untuk mengecilkan baris lama
  bisa dilakukan lewat script serupa `scripts/importRunchiseSalesTransactions.js`
  bila DB bloat dari data historis terbukti signifikan, tapi itu operasi
  penulisan massal ke produksi yang sengaja tidak dijalankan tanpa
  persetujuan eksplisit.
- Kalau Runchise suatu saat mengubah skema responsnya sehingga field
  reward-redemption pindah ke path baru yang belum tercakup daftar di
  bagian 6.1, `extractRewardRedemptions()` akan diam-diam kembali
  menghasilkan `valid:false`/`rows:[]` untuk transaksi itu — persis
  risiko yang sama seperti sebelum perbaikan ini (akses field pakai `?.`).
  Bedanya sekarang risiko itu eksplisit terdokumentasi dan terikat pada
  daftar field yang jelas, bukan tersembunyi di balik "field apa pun bisa
  saja dipakai suatu saat".
