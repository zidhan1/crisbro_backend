# L-2 (LOW) — CSP dimatikan global

Status: **Fixed**

File terdampak:

- Backend: `src/index.js`, `src/middleware/docsCsp.js` (baru),
  `src/docs/swagger.js`

## 1. Masalah

Content-Security-Policy (CSP) dimatikan untuk **seluruh aplikasi**, bukan
hanya untuk halaman Swagger yang membutuhkannya:

```js
app.use(helmet({ contentSecurityPolicy: false }));
```

Alasannya adalah halaman `/api/docs` (Swagger UI) memuat aset dari CDN dan
menjalankan satu blok `<script>` inline untuk inisialisasi
`SwaggerUIBundle`, yang akan diblokir CSP default. Namun karena
`contentSecurityPolicy: false` dipasang di level `app.use(helmet(...))`
paling atas, seluruh endpoint API (termasuk semua endpoint JSON, endpoint
admin, dan endpoint auth) ikut kehilangan header CSP.

Dampaknya memperbesar temuan H-2 (baca
`fix-H2-admin-token-http-only-cookie.md`): CSP adalah salah satu lapisan
pertahanan utama terhadap XSS karena dapat memblokir eksekusi script asing
yang berhasil disuntikkan (mis. lewat input yang tidak tersanitasi dengan
benar, dependency frontend yang tervulnerable, dsb). Tanpa CSP sama sekali,
satu-satunya penghalang terhadap payload XSS yang mengeksekusi script adalah
sanitasi output di sisi frontend — tidak ada pertahanan berlapis di level
transport/browser.

## 2. Kondisi sebelum perbaikan

```http
GET /api/my-points HTTP/1.1
Authorization: Bearer <token>

HTTP/1.1 200 OK
Content-Type: application/json
(tidak ada header Content-Security-Policy)
```

```http
GET /api/docs HTTP/1.1

HTTP/1.1 200 OK
Content-Type: text/html
(tidak ada header Content-Security-Policy)
```

Semua response, baik JSON API maupun halaman docs, sama-sama tidak memiliki
proteksi CSP.

## 3. Perbaikan

### 3.1 CSP ketat diaktifkan secara global

`src/index.js` sekarang mengaktifkan CSP untuk seluruh aplikasi dengan
kebijakan ketat yang sesuai untuk API JSON (tidak ada halaman yang merender
HTML selain docs):

```js
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);
```

Tidak ada `'unsafe-inline'` maupun `'unsafe-eval'` pada directive apa pun di
level global. Header ini secara fungsional tidak memengaruhi response JSON
(browser hanya menegakkan CSP pada dokumen yang dirender, bukan pada body
JSON yang dikonsumsi lewat `fetch`/`XHR`), tetapi tetap berguna sebagai
pertahanan berlapis untuk endpoint mana pun yang di masa depan merender HTML
atau bila response ter-refleksi langsung di browser.

### 3.2 CSP halaman Swagger dipisah dari CSP API

`src/middleware/docsCsp.js` (baru) berisi middleware
`docsContentSecurityPolicy` yang **hanya** dipasang pada route HTML docs:

```js
app.get(
  ['/api/docs', '/api/docs/'],
  docsContentSecurityPolicy,
  requireDocsAccess,
  (req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(renderSwaggerHtml(res.locals.cspNonce));
  },
);
```

Middleware ini membuat **nonce acak per request** (`crypto.randomBytes(16)`)
dan menetapkan CSP khusus halaman docs:

```js
directives: {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'", `'nonce-${nonce}'`, 'https://cdn.jsdelivr.net'],
  styleSrc: ["'self'", 'https://cdn.jsdelivr.net', "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
  fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  frameAncestors: ["'none'"],
}
```

`script-src` **tidak** memakai `'unsafe-inline'`. Satu-satunya script inline
yang diizinkan adalah yang membawa nonce yang cocok, dan nonce tersebut
dibuat ulang setiap request lalu disuntikkan ke `<script>`/`<style>` inline
milik halaman docs melalui `renderSwaggerHtml(nonce)`
(`src/docs/swagger.js`):

```js
function renderSwaggerHtml(nonce) {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  // ...
  // <style${nonceAttr}> ... </style>
  // <script${nonceAttr}> window.onload = function () { ... }; </script>
}
```

Script eksternal dari `cdn.jsdelivr.net` (bundle Swagger UI) tetap diizinkan
lewat allowlist host, terpisah dari mekanisme nonce.

`style-src` mengizinkan `'unsafe-inline'` karena `swagger-ui-bundle`
menyuntikkan elemen `<style>` secara dinamis di runtime (untuk syntax
highlighting request/response body) tanpa atribut nonce, di luar kendali
kode aplikasi. ini adalah trade-off yang disengaja dan didokumentasikan di
`src/middleware/docsCsp.js`: injeksi CSS saja tidak dapat mengeksekusi
JavaScript, sehingga risikonya jauh lebih rendah dibanding mengizinkan
`'unsafe-inline'` pada `script-src` — yang justru menjadi vektor utama XSS
dan sudah ditutup.

### 3.3 Route `openapi.json` tetap memakai CSP global

`GET /api/docs/openapi.json` mengembalikan JSON, bukan HTML, sehingga tidak
memerlukan CSP khusus — cukup memakai kebijakan ketat global di atas.

## 4. Output setelah perbaikan

### Endpoint API JSON (mis. `/api/my-points`, `/api/admin/...`)

```http
GET /api/my-points HTTP/1.1

HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;connect-src 'self';font-src 'self';object-src 'none';base-uri 'none';form-action 'self';frame-ancestors 'none'
Content-Type: application/json
```

### Halaman Swagger (`/api/docs`)

```http
GET /api/docs HTTP/1.1

HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none';script-src 'self' 'nonce-<acak-per-request>' https://cdn.jsdelivr.net;style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline';img-src 'self' data: https://cdn.jsdelivr.net;font-src 'self' https://cdn.jsdelivr.net;connect-src 'self';object-src 'none';base-uri 'none';frame-ancestors 'none'
Cache-Control: no-store
Content-Type: text/html
```

Nonce berbeda pada setiap request, sehingga tidak bisa ditebak/dipakai ulang
oleh penyerang.

## 5. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Header CSP pada seluruh API | Tidak ada (`contentSecurityPolicy: false`) | Aktif, kebijakan ketat (`'self'` only) |
| Header CSP pada halaman docs | Tidak ada | Aktif, khusus untuk docs (CDN + nonce) |
| Inline script diizinkan di docs | Otomatis lolos (tidak ada CSP sama sekali) | Hanya dengan nonce per-request yang valid |
| Inline script asing hasil XSS | Bisa langsung tereksekusi di endpoint mana pun | Diblokir `script-src` di seluruh API dan di docs (tidak punya nonce yang valid) |
| Inline style di docs | Lolos begitu saja | Lolos lewat `'unsafe-inline'` yang disengaja (risiko rendah, didokumentasikan) |
| Cakupan pematian CSP | Global (semua route) | Tidak ada; hanya kebijakan yang disesuaikan per kebutuhan |

## 6. Verifikasi

### Pemeriksaan sintaks

```text
node --check src/index.js
node --check src/middleware/docsCsp.js
node --check src/docs/swagger.js

Exit code: 0
```

### Verifikasi header CSP langsung ke server dev

```text
curl -i http://localhost:5000/
Content-Security-Policy: default-src 'self';script-src 'self';style-src 'self';...

curl -i http://localhost:5000/api/docs
Content-Security-Policy: default-src 'none';script-src 'self' 'nonce-URrImHJmuw3uHlCEiTqWeA==' https://cdn.jsdelivr.net;...
```

### Verifikasi di browser (Swagger UI benar-benar berfungsi di bawah CSP baru)

- `GET /api/docs` dibuka di browser: halaman termuat penuh (judul
  "Crisbar Rewards API", daftar seluruh tag/endpoint tampil normal).
- Console browser: **tidak ada** pesan error/violation CSP.
- Network request: hanya `GET /api/docs/openapi.json` (200) dan dua
  `data:image/svg+xml` (ikon bawaan Swagger UI, diizinkan oleh
  `img-src ... data:`) — tidak ada resource yang diblokir.

Ini membuktikan `script-src` yang ketat (tanpa `'unsafe-inline'`) tidak
merusak fungsionalitas Swagger UI karena satu-satunya script inline yang
dibutuhkan sudah dibawakan nonce yang sah.

## 7. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Aktifkan CSP | CSP ketat aktif secara global di `src/index.js`, tidak ada lagi `contentSecurityPolicy: false` |
| Pisahkan halaman docs dari kebijakan API | `docsContentSecurityPolicy` di `src/middleware/docsCsp.js` menimpa CSP hanya untuk route `/api/docs` |
| (alternatif) Ganti Swagger dengan aset tanpa inline-script | Tidak dipakai; sebagai gantinya script inline yang tersisa diberi nonce per-request sehingga tetap aman tanpa mengganti Swagger UI |

## 8. Yang tidak berubah dan risiko residual

- `style-src` pada halaman docs tetap mengizinkan `'unsafe-inline'` karena
  keterbatasan `swagger-ui-bundle` (lihat 3.2). Ini adalah risiko residual
  yang disengaja dan berdampak rendah (CSS injection, bukan eksekusi
  JavaScript).
- CSP adalah pertahanan berlapis, bukan pengganti sanitasi input/output.
  Endpoint yang menerima input pengguna tetap harus memvalidasi dan
  meng-escape output sebagaimana mestinya.
- `helmet` tetap memasang header keamanan lain (HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`, dll.) tanpa perubahan.
- Tidak ada perubahan pada CORS, rate limiting, atau middleware auth/role;
  perbaikan ini murni pada header CSP.

## 9. Checklist deployment

1. Tidak ada variabel environment baru yang wajib diisi untuk perbaikan ini.
2. Setelah deploy, verifikasi header `Content-Security-Policy` muncul pada
   response API biasa (`default-src 'self'`) dan pada `/api/docs`
   (allowlist CDN + nonce).
3. Bila kelak menambahkan halaman HTML baru selain docs, jangan menaikkan
   `'unsafe-inline'`/`'unsafe-eval'` pada CSP global — buat middleware CSP
   khusus route tersebut mengikuti pola `docsContentSecurityPolicy`.
4. Bila `SWAGGER_CDN_ORIGIN` (`cdn.jsdelivr.net`) diganti ke CDN lain atau
   di-self-host, perbarui allowlist di `src/middleware/docsCsp.js` secara
   bersamaan.
