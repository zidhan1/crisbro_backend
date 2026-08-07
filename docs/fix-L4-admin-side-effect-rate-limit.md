# L-4 (LOW) — Endpoint efek-samping tanpa rate-limit khusus

Status: **Fixed**

File terdampak:

- `src/lib/rateLimit.js`
- `src/routes/adminLoyaltyRoutes.js`
- `test/adminSideEffectRateLimit.test.js` (baru)

## 1. Masalah

Dua endpoint admin/marketing menghasilkan efek samping yang mahal tetapi
sebelumnya hanya dilindungi limiter global:

```js
router.post(
  '/customers/:id/activation',
  adminOrMarketing,
  resendCustomerActivation,
);
router.post(
  '/customers/:id/runchise-sync',
  adminOrMarketing,
  retryCustomerRunchiseSync,
);
```

`POST /customers/:id/activation` mengirim email aktivasi, sedangkan
`POST /customers/:id/runchise-sync` memanggil API eksternal Runchise. Limiter
global sebesar 300 request per 5 menit terlalu longgar untuk efek samping ini.

Dampak yang mungkin terjadi:

- satu customer menerima email aktivasi berulang (spam);
- API Runchise dan koneksi aplikasi menerima beban retry berlebihan;
- beberapa akun admin/marketing atau beberapa instance aplikasi dapat
  bersama-sama menarget customer yang sama;
- limiter per IP saja tidak cukup karena target yang perlu dilindungi adalah
  customer.

## 2. Kondisi sebelum perbaikan

Contoh request berulang:

```http
POST /api/admin/customers/101/activation
Authorization: Bearer <admin-token>

HTTP/1.1 200 OK
```

Request tersebut dapat diulang sampai mencapai limiter global. Tidak ada
kuota khusus customer 101 dan tidak ada batas terpisah untuk email atau API
Runchise.

## 3. Perbaikan

### 3.1 Limiter per endpoint dan per target

Dua limiter khusus ditambahkan ke `src/lib/rateLimit.js`:

| Endpoint | Prefix counter | Jendela | Maksimum | Target key |
|---|---|---:|---:|---|
| Resend activation | `admin-resend-activation` | 15 menit | 3 | Customer ID |
| Retry Runchise sync | `admin-runchise-sync` | 15 menit | 5 | Customer ID |

Key target dinormalisasi menjadi integer positif:

```js
function customerTargetKey(req) {
  const customerId = Number(req.params?.id);
  return Number.isInteger(customerId) && customerId > 0
    ? `customer:${customerId}`
    : 'customer:invalid';
}
```

Dengan demikian `/customers/101/...` dan `/customers/0101/...` memakai kuota
yang sama dan format ID tidak bisa digunakan untuk melewati batas.

Prefix yang berbeda membuat kuota resend email dan retry sync independen.
Customer yang berbeda juga memiliki counter masing-masing.

### 3.2 Counter terdistribusi dan atomik

Limiter menggunakan `PrismaRateLimitStore` yang sudah dipakai limiter auth.
Counter disimpan di tabel PostgreSQL `RateLimitCounter` melalui operasi
`INSERT ... ON CONFLICT DO UPDATE` atomik. Batas berlaku bersama pada semua
instance aplikasi dan tidak hilang saat serverless cold start.

Tidak ada migration baru karena tabel penyimpanan limiter sudah tersedia.

### 3.3 Urutan middleware

Route setelah perbaikan:

```js
router.post(
  '/customers/:id/activation',
  adminOrMarketing,
  resendActivationTargetLimiter,
  resendCustomerActivation,
);
```

Urutannya adalah:

1. `router.use(auth)` memverifikasi sesi;
2. `adminOrMarketing` memverifikasi role;
3. limiter khusus menghitung request berdasarkan customer;
4. controller menjalankan efek samping bila kuota masih tersedia.

Request tanpa autentikasi atau role yang sesuai ditolak sebelum counter
customer bertambah. Ini mencegah pihak tanpa hak akses menghabiskan kuota
target.

## 4. Output setelah perbaikan

### Resend activation, request pertama sampai ketiga

```http
HTTP/1.1 200 OK
RateLimit-Limit: 3
RateLimit-Remaining: 2
RateLimit-Reset: 900
```

Nilai `RateLimit-Remaining` berkurang pada request berikutnya.

### Resend activation, request keempat dalam 15 menit

```http
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 3
RateLimit-Remaining: 0
Retry-After: 900
Content-Type: application/json

{
  "message":"Terlalu banyak pengiriman aktivasi untuk customer ini. Silakan coba lagi nanti."
}
```

### Retry Runchise sync, request keenam dalam 15 menit

```http
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 5
RateLimit-Remaining: 0
Retry-After: 900
Content-Type: application/json

{
  "message":"Terlalu banyak percobaan sinkronisasi untuk customer ini. Silakan coba lagi nanti."
}
```

Nilai reset/retry aktual mengikuti sisa waktu jendela sehingga dapat sedikit
lebih kecil dari 900 detik.

## 5. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Perlindungan khusus resend activation | Tidak ada | 3/customer/15 menit |
| Perlindungan khusus Runchise sync | Tidak ada | 5/customer/15 menit |
| Cakupan counter | Global per request source | Per endpoint dan customer target |
| Multi-instance/serverless | Hanya mengandalkan limiter global | Counter target terdistribusi di PostgreSQL |
| Variasi ID `101`/`0101` | Tidak relevan | Dinormalisasi ke target yang sama |
| Respons saat dibatasi | Limiter global baru aktif pada volume tinggi | HTTP 429 + `Retry-After` + pesan spesifik |
| Request unauthorized | Dilindungi auth | Tetap ditolak sebelum memakai kuota target |

## 6. Verifikasi otomatis

Test integrasi menggunakan Express dan store Prisma terkontrol untuk
memastikan:

1. tiga resend pertama berhasil dan request keempat mendapat HTTP 429;
2. header limit dan `Retry-After` tersedia;
3. ID `101` dan `0101` berbagi counter;
4. customer lain tetap memiliki kuota sendiri;
5. kuota resend dan Runchise sync tidak saling memengaruhi;
6. lima sync pertama berhasil dan request keenam mendapat HTTP 429.

Perintah:

```text
node --test test/adminSideEffectRateLimit.test.js
npm test
node --check src/lib/rateLimit.js
node --check src/routes/adminLoyaltyRoutes.js
```

## 7. Operasional dan pengukuran

- HTTP 429 dapat dipantau per path untuk melihat aktivitas pembatasan.
- Header standar rate-limit memberi dashboard informasi batas dan sisa
  kuota tanpa membuat kontrak response khusus.
- Counter kedaluwarsa dibersihkan oleh mekanisme
  `pruneRateLimitCounters` yang sudah tersedia.
- Prefix database yang berbeda memudahkan inspeksi counter berdasarkan jenis
  efek samping.

## 8. Yang tidak berubah dan risiko residual

- Hak akses endpoint tetap `admin` atau `marketing`.
- Response sukses dan log aktivitas admin tidak berubah.
- Limiter global tetap aktif sebagai lapisan pembatas umum.
- Pembatasan mengurangi spam/beban berlebihan, tetapi tidak menjamin layanan
  email atau Runchise selalu tersedia.
- Nilai 3 dan 5 dipilih agar retry operasional masih memungkinkan tanpa
  membolehkan loop agresif. Perubahan nilai di masa depan harus disertai data
  operasional dan pembaruan test/dokumentasi.

## 9. Checklist deployment

1. Pastikan migration yang menyediakan tabel `RateLimitCounter` sudah
   diterapkan seperti pada limiter auth yang ada.
2. Tidak ada environment variable atau dependency baru.
3. Setelah deploy, lakukan resend empat kali pada customer test dan pastikan
   request keempat menghasilkan HTTP 429.
4. Pastikan customer lain tidak ikut terblokir.
5. Pantau jumlah HTTP 429 dan log error layanan eksternal untuk mengevaluasi
   apakah batas perlu disesuaikan.
