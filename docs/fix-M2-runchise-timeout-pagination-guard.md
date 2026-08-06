# M-2 (MEDIUM) — Timeout Runchise melampaui budget serverless dan paginator tanpa hard cap

Status: **Fixed untuk timeout/retry per request dan hard page cap**

File terdampak:

- `src/services/runchiseService.js`
- `test/runchiseServiceSafety.test.js`

Kategori: **Reliabilitas, External API, Serverless Budget**

## 1. Masalah

Client Axios Runchise sebelumnya memakai timeout default 30 detik:

```js
const runchiseClient = axios.create({
  timeout: Number(process.env.RUNCHISE_API_TIMEOUT_MS || 30000),
});
```

`requestWithRetry` mengizinkan dua retry setelah request pertama. Satu request
upstream yang terus timeout dapat memiliki worst-case teoritis:

```text
attempt 1  30.000 ms
backoff       500 ms
attempt 2  30.000 ms
backoff     1.000 ms
attempt 3  30.000 ms
---------------------
total       91.500 ms
```

Nilai tersebut jauh melampaui jendela eksekusi serverless 30 detik. Runtime
dapat menghentikan fungsi sebelum timeout Axios selesai, sebelum retry selesai,
dan sebelum checkpoint/job state sempat diperbarui.

## 2. Paginator tanpa hard cap

Enam jalur `fetchAll*` memakai `while (hasMore)` tanpa batas halaman:

- `fetchAllCustomers`
- `fetchAllSalesTransactions`
- `fetchAllProducts`
- `fetchAllSubBrands`
- `fetchAllLocations`
- `fetchAllPromos`

Contoh lama:

```js
while (hasMore) {
  const data = await fetchCustomersPage(locationId, page);
  allCustomers = allCustomers.concat(data.customers);
  hasMore = data.paging.next_page !== null;
  page++;
}
```

Jika upstream terus mengembalikan `next_page`, `total_item` yang salah, atau
halaman penuh berulang, loop dapat berjalan sangat lama. Endpoint customer
diketahui dapat melaporkan `total_item: 10000`; dengan page size 100, satu
outlet dapat mencapai 100 request.

Paginator sales memiliki tiga fallback:

```text
next_page
total_item
page penuh == page size
```

Tanpa hard cap, fallback halaman penuh paling berisiko jika API mengulang data
atau tidak pernah mengirim halaman pendek.

## 3. Dampak sebelum perbaikan

- Invocation serverless dapat dibunuh sebelum Axios timeout.
- Retry tidak sempat memberikan manfaat karena runtime lebih dulu dihentikan.
- Worker/checkpoint dapat tertinggal dalam status running.
- Cron berikutnya dapat menganggap pekerjaan sebelumnya masih aktif atau harus
  mengulang pekerjaan yang sama.
- Paginator dapat menghasilkan request upstream dalam jumlah tidak terukur.
- API Runchise, koneksi aplikasi, memory array hasil, dan database dapat
  menerima beban berlebihan.
- Error operasional sulit dibedakan dari timeout platform.

## 4. Kondisi sebelum perbaikan

### Timeout dan retry

```text
RUNCHISE_API_TIMEOUT_MS tidak diisi
                 │
                 ▼
timeout = 30 detik
                 │
                 ▼
request + retry 2x = sampai 91,5 detik
                 │
                 ▼
serverless kill sebelum alur selesai
```

### Pagination

```text
while (hasMore)
   ├── next_page selalu tersedia
   ├── total_item tidak akurat
   └── halaman selalu penuh
             │
             ▼
    tidak ada batas terminasi lokal
```

## 5. Perbaikan timeout dan retry

### 5.1 Timeout default diturunkan

Default timeout sekarang 6 detik:

```text
RUNCHISE_REQUEST_TIMEOUT_MS = 6000
```

Environment variable tetap didukung:

```env
RUNCHISE_API_TIMEOUT_MS=6000
```

Nilai konfigurasi dikunci:

| Konfigurasi | Default | Minimum | Maksimum |
|---|---:|---:|---:|
| `RUNCHISE_API_TIMEOUT_MS` | 6000 ms | 1000 ms | 8000 ms |
| `RUNCHISE_API_MAX_RETRIES` | 1 | 0 | 2 |

Nilai di luar rentang tidak dapat membuat request tunggal menunggu 30 detik
atau retry tanpa batas.

### 5.2 Retry override tunduk pada global cap

Sebelumnya caller promo meminta `{ retries: 3 }`. Sekarang override caller
selalu dikunci oleh `RUNCHISE_MAX_RETRIES`:

```js
const effectiveRetries = Math.min(
  Math.max(0, retries),
  RUNCHISE_MAX_RETRIES,
);
```

Caller tidak dapat secara tidak sengaja melampaui budget global.

### 5.3 Worst-case budget dapat dihitung

`getRetryBudgetMs()` menghitung timeout seluruh attempt ditambah exponential
backoff.

Konfigurasi default:

```text
attempt 1   6.000 ms
backoff       500 ms
attempt 2   6.000 ms
--------------------
total       12.500 ms
```

Konfigurasi maksimum yang diizinkan:

```text
attempt 1   8.000 ms
backoff       500 ms
attempt 2   8.000 ms
backoff     1.000 ms
attempt 3   8.000 ms
--------------------
total       25.500 ms
```

Worst-case per upstream request tetap di bawah 30 detik.

## 6. Perbaikan pagination

### 6.1 Guard bersama

Semua paginator memakai helper yang sama:

```js
assertPageWithinLimit(resource, page);
```

Konfigurasi:

```env
RUNCHISE_API_MAX_PAGES=100
```

| Konfigurasi | Default | Minimum | Hard maximum konfigurasi |
|---|---:|---:|---:|
| `RUNCHISE_API_MAX_PAGES` | 100 | 1 | 1000 |

Default 100 tetap memungkinkan pengambilan customer sampai 10.000 baris pada
page size 100, tetapi tidak membiarkan API meminta halaman ke-101 tanpa sinyal
error.

### 6.2 Fail-fast terukur

Jika upstream masih menyatakan ada data setelah cap:

```text
Pagination customers melewati batas aman 100 halaman
```

Error membawa metadata:

```js
{
  code: 'RUNCHISE_MAX_PAGES_EXCEEDED',
  resource: 'customers',
  page: 101,
  maxPages: 100,
}
```

Proses tidak mengembalikan hasil parsial seolah-olah lengkap. Caller dapat
mencatat kegagalan, melakukan retry terarah, atau memindahkan pekerjaan ke
worker/checkpoint.

### 6.3 Coverage guard

Guard dipasang pada seluruh enam loop:

```text
customers
sales transactions
products
sub brands
locations
promos
```

## 7. Alur setelah perbaikan

```text
Mulai upstream request
        │
        ├── timeout 1–8 detik
        ├── retry hanya untuk error transient
        ├── retry maksimum 0–2
        └── backoff masuk perhitungan budget
        │
        ▼
Terima satu halaman
        │
        ├── page <= max ──► proses halaman
        │
        └── page > max  ──► throw RUNCHISE_MAX_PAGES_EXCEEDED
```

## 8. Output setelah perbaikan

### Upstream pulih saat retry

```text
Fetch products Runchise page 3 gagal sementara (ETIMEDOUT), retry 1/1
```

Jika attempt kedua berhasil, data dikembalikan normal.

### Upstream tetap timeout

Dengan default, error diteruskan setelah maksimal sekitar 12,5 detik, bukan
menunggu sampai 91,5 detik.

### Pagination normal

```text
page 1 ... page 100
hasMore = false
return seluruh hasil
```

### Pagination melewati cap

```text
page 100 selesai
upstream masih menyatakan next_page
page menjadi 101
throw RUNCHISE_MAX_PAGES_EXCEEDED
```

## 9. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Timeout default | 30 detik | 6 detik |
| Timeout maksimum konfigurasi | Tidak dibatasi | 8 detik |
| Retry default | 2 | 1 |
| Retry maksimum | Caller dapat meminta 3+ | Hard cap 2 |
| Worst-case per request | 91,5 detik default | 12,5 detik default |
| Worst-case konfigurasi | Tidak terukur | Maksimum 25,5 detik |
| Hard max-page | Tidak ada pada enam paginator | Guard bersama |
| Loop upstream rusak | Dapat terus berjalan | Error terstruktur |
| Hasil saat cap tercapai | Tidak terdefinisi | Gagal eksplisit, bukan sukses parsial |

## 10. Verifikasi

Test khusus M-2:

```text
ok - timeout dan worst-case retry budget selalu di bawah 30 detik
ok - page terakhir diterima dan halaman setelah hard cap ditolak terukur
ok - override retry berlebih tetap dikunci oleh budget global
```

Test ketiga benar-benar menjalankan error transient tiruan dan membuktikan
jumlah attempt sama dengan cap global.

Hasil seluruh suite backend:

```text
tests 11
pass 11
fail 0
cancelled 0
skipped 0
```

Pemeriksaan tambahan:

```text
node --check src/services/runchiseService.js
node --check test/runchiseServiceSafety.test.js
git diff --check

Exit code: 0
```

Pencarian struktural membuktikan setiap `while (hasMore)` pada service memiliki
`assertPageWithinLimit`.

Test tidak memanggil API Runchise dan tidak menulis database production.

## 11. Yang sudah diperbaiki

- Timeout 30 detik tidak lagi menjadi default.
- Environment tidak dapat menaikkan timeout di atas 8 detik.
- Retry dan backoff memiliki worst-case yang dapat dihitung.
- Override retry lokal tidak dapat melewati global cap.
- Semua paginator memiliki hard page cap.
- Pelanggaran cap menghasilkan kode error dan metadata yang dapat dimonitor.
- Direct create customer juga memakai timeout client baru walaupun tidak
  melakukan retry.

## 12. Yang belum diperbaiki / risiko residual

- Budget 25,5 detik adalah budget **satu halaman/request**, bukan seluruh
  operasi `fetchAll*`. Beberapa halaman lambat berturut-turut masih dapat
  melampaui satu invocation serverless.
- `fetchAllCustomers`, sales, product, sub-brand, location, dan promo masih
  mengumpulkan hasil ke array memory. Hard cap membatasi jumlah halaman tetapi
  tidak menjadikan memory konstan.
- Paginator `fetchAll*` belum semuanya memiliki checkpoint/cursor persisten.
- Request yang sedang berjalan tidak mengetahui sisa waktu aktual dari runtime
  serverless.
- Cap 100 adalah batas keselamatan, bukan jaminan bahwa 100 halaman dapat
  selesai dalam satu invocation.
- Timeout lebih singkat dapat meningkatkan jumlah kegagalan pada jaringan yang
  memang lambat; monitoring diperlukan untuk membedakan upstream lambat dari
  gangguan permanen.

## 13. Tindak lanjut yang disarankan

1. Gunakan worker per halaman dengan checkpoint database untuk dataset besar,
   mengikuti pola customer import yang sudah ada.
2. Simpan cursor/page terakhir, heartbeat, status, dan error per resource.
3. Hentikan worker sebelum mendekati `maxDuration`, lalu lanjutkan pada invocation
   berikutnya.
4. Tambahkan metrik latency per attempt, retry count, page count, dan error code.
5. Gunakan cursor pagination bila API Runchise menyediakannya; lebih stabil
   daripada offset page saat data berubah selama sinkronisasi.
6. Evaluasi cap berbeda per resource setelah mengukur jumlah halaman nyata.
7. Jangan menaikkan `RUNCHISE_API_TIMEOUT_MS` atau max pages sebagai solusi
   timeout serverless tanpa menghitung ulang end-to-end budget.

## 14. Konfigurasi deployment

Konfigurasi yang direkomendasikan:

```env
RUNCHISE_API_TIMEOUT_MS=6000
RUNCHISE_API_MAX_RETRIES=1
RUNCHISE_API_MAX_PAGES=100
```

Nilai yang tidak valid kembali ke default; nilai valid di luar batas akan
dikunci ke minimum/maksimum aman.

Checklist:

1. Deploy tanpa migration database.
2. Pantau `ECONNABORTED`, `ETIMEDOUT`, HTTP 429, dan HTTP 5xx.
3. Buat alert untuk `RUNCHISE_MAX_PAGES_EXCEEDED`.
4. Bandingkan jumlah page aktual dengan cap untuk setiap resource.
5. Pastikan job checkpoint besar tidak diganti kembali menjadi `fetchAll*`
   sinkron di satu request serverless.
