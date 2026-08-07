# L-1 (LOW) — Swagger UI & openapi.json publik tanpa auth

Status: **Fixed**

File terdampak:

- Backend: `src/index.js`, `src/middleware/docsAccess.js` (baru),
  `src/lib/safeCompare.js` (baru)

## 1. Masalah

`GET /api/docs` (Swagger UI) dan `GET /api/docs/openapi.json` dapat diakses
siapa pun tanpa autentikasi, termasuk di production:

```js
app.get('/api/docs/openapi.json', (req, res) => res.json(openApiSpec));
app.get(['/api/docs', '/api/docs/'], (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(renderSwaggerHtml());
});
```

Kedua endpoint tersebut mengungkap seluruh permukaan API ke publik: daftar
lengkap route, method, parameter, skema request/response, dan struktur error.
Informasi ini mempermudah pihak luar memetakan API (termasuk endpoint admin
dan sync) sebagai langkah awal sebelum mencoba serangan lain, walaupun
endpoint itu sendiri tetap dilindungi middleware auth/role masing-masing.

## 2. Kondisi sebelum perbaikan

```http
GET /api/docs/openapi.json HTTP/1.1
Host: api.crisbar.example

HTTP/1.1 200 OK
Content-Type: application/json

{ "openapi": "3.0.0", "paths": { "/api/admin/...": { ... }, ... } }
```

```http
GET /api/docs HTTP/1.1
Host: api.crisbar.example

HTTP/1.1 200 OK
Content-Type: text/html

<!DOCTYPE html> ... Swagger UI ...
```

Tidak ada pemeriksaan `NODE_ENV`, tidak ada autentikasi, dan tidak ada cara
mengontrol paparan endpoint ini per lingkungan.

## 3. Perbaikan

### 3.1 Middleware `requireDocsAccess`

Ditambahkan `src/middleware/docsAccess.js` dan dipasang pada kedua route:

```js
app.get('/api/docs/openapi.json', requireDocsAccess, (req, res) =>
  res.set('Cache-Control', 'no-store').json(openApiSpec),
);
app.get(['/api/docs', '/api/docs/'], requireDocsAccess, (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(renderSwaggerHtml());
});
```

### 3.2 Aturan akses

```text
NODE_ENV != production
  -> docs aktif tanpa auth (kebutuhan development), KECUALI
     API_DOCS_USER/API_DOCS_PASSWORD sudah diisi -> Basic Auth tetap dicek

NODE_ENV == production
  API_DOCS_ENABLED != "true"            -> 404 (docs nonaktif, default)
  API_DOCS_ENABLED == "true"
    tanpa API_DOCS_USER/API_DOCS_PASSWORD -> 503 (gagal tertutup, bukan terbuka)
    dengan kredensial lengkap             -> wajib Basic Auth yang valid
```

Respons untuk docs yang nonaktif memakai `404`, bukan `403`, agar tidak
mengonfirmasi ke publik bahwa endpoint tersebut ada.

Perbandingan username/password memakai `crypto.timingSafeEqual` melalui
`safeStringEqual` (dipindahkan ke `src/lib/safeCompare.js` dan dipakai
bersama oleh `requireDocsAccess` dan `requireCronSecret`, menghindari
duplikasi logika timing-safe compare yang sebelumnya hanya ada di
`index.js`).

### 3.3 Variabel environment baru

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `API_DOCS_ENABLED` | Tidak | nonaktif | Set `"true"` untuk mengizinkan docs diakses di production |
| `API_DOCS_USER` | Ya, jika docs diaktifkan di production | — | Username Basic Auth untuk `/api/docs*` |
| `API_DOCS_PASSWORD` | Ya, jika docs diaktifkan di production | — | Password Basic Auth untuk `/api/docs*` |

Di non-production, mengisi `API_DOCS_USER`/`API_DOCS_PASSWORD` juga akan
mengaktifkan Basic Auth (opsional, berguna untuk lingkungan staging yang
mirip production).

## 4. Output setelah perbaikan

### Production, default (belum dikonfigurasi)

```http
GET /api/docs/openapi.json HTTP/1.1

HTTP/1.1 404 Not Found
```

### Production, `API_DOCS_ENABLED=true` tanpa kredensial

```http
GET /api/docs HTTP/1.1

HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{ "message": "API_DOCS_USER/API_DOCS_PASSWORD belum dikonfigurasi" }
```

### Production, `API_DOCS_ENABLED=true` dengan kredensial, tanpa auth

```http
GET /api/docs HTTP/1.1

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="Crisbar API Docs"
Content-Type: application/json

{ "message": "Unauthorized" }
```

### Production, kredensial benar

```http
GET /api/docs HTTP/1.1
Authorization: Basic ZG9jc3VzZXI6ZG9jc3Bhc3M=

HTTP/1.1 200 OK
Content-Type: text/html
Cache-Control: no-store
```

### Development (default, tanpa kredensial diisi)

```http
GET /api/docs/openapi.json HTTP/1.1

HTTP/1.1 200 OK
```

Perilaku development tidak berubah dari sebelumnya, sehingga tidak
mengganggu alur kerja lokal.

## 5. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Akses docs di production | Publik, tanpa syarat | 404 secara default |
| Docs diaktifkan tanpa kredensial di production | Tidak mungkin dicegah | 503 (gagal tertutup) |
| Docs diaktifkan dengan kredensial di production | — | Basic Auth wajib, timing-safe compare |
| Akses docs di development | Publik, tanpa syarat | Tetap publik (tidak berubah) kecuali kredensial diisi |
| Duplikasi logika compare timing-safe | Ada, hanya di `requireCronSecret` | Disatukan di `src/lib/safeCompare.js` |
| Cache header pada `openapi.json` | Tidak ada | `Cache-Control: no-store` |

## 6. Verifikasi

Verifikasi otomatis dijalankan dengan Express + `http` langsung (tanpa
menyentuh database), mencakup 6 skenario: development tanpa kredensial,
production default, production aktif tanpa kredensial, production aktif
dengan kredensial tanpa header auth, dengan auth salah, dan dengan auth
benar. Seluruh skenario menghasilkan status code sesuai desain di atas.

```text
PASS: dev + no creds -> 200
PASS: prod default -> 404
PASS: prod enabled, no creds -> 503
PASS: prod enabled+creds, no auth -> 401
PASS: prod enabled+creds, wrong auth -> 401
PASS: prod enabled+creds, correct auth -> 200
ALL TESTS PASSED
```

Pemeriksaan sintaks:

```text
node --check src/index.js
node --check src/middleware/docsAccess.js
node --check src/lib/safeCompare.js

Exit code: 0
```

## 7. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Proteksi dengan auth/basic-auth | `requireDocsAccess` mewajibkan Basic Auth bila docs diaktifkan |
| Nonaktifkan docs di produksi (aktif hanya non-prod) | Default production adalah `404`; harus diaktifkan eksplisit lewat `API_DOCS_ENABLED` |

## 8. Yang tidak berubah dan risiko residual

- Endpoint API yang didokumentasikan Swagger tetap dilindungi middleware
  `auth`/`requireRole` masing-masing; perbaikan ini hanya menutup akses ke
  *dokumentasi* API, bukan API itu sendiri.
- Bila operator memilih mengaktifkan docs di production, kekuatan proteksi
  bergantung pada kekuatan `API_DOCS_PASSWORD` yang dipilih — gunakan
  password acak yang panjang, sama seperti `CRON_SECRET`.
- Basic Auth mengirim kredensial ter-encode base64 pada setiap request;
  pastikan endpoint hanya diakses lewat HTTPS di production (sudah menjadi
  asumsi deployment saat ini).

## 9. Checklist deployment

1. Secara default, biarkan `API_DOCS_ENABLED` kosong/`false` di production.
2. Bila docs production benar-benar diperlukan (misal untuk tim eksternal),
   set `API_DOCS_ENABLED=true`, `API_DOCS_USER`, dan `API_DOCS_PASSWORD`
   dengan nilai yang kuat dan unik (jangan pakai ulang password lain).
3. Simpan kredensial docs di secret manager/environment platform deployment,
   bukan di repo.
4. Setelah deploy, verifikasi `GET /api/docs` mengembalikan `404` bila docs
   tidak diaktifkan, atau meminta Basic Auth bila diaktifkan.
