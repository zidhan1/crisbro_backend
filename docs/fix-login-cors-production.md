# Perbaikan Login CORS Production

## Masalah sebelumnya

Backend hanya membentuk allowlist CORS dari `FRONTEND_URL` dan
`CORS_ORIGINS`. Jika environment variable pada deployment Vercel tidak ada,
salah environment, atau belum ikut redeploy, preflight login dari frontend
produksi ditolak sebelum pemeriksaan kredensial:

```http
OPTIONS /api/login
Origin: https://crisbro-frontend.vercel.app

HTTP/1.1 403 Forbidden
{"message":"Origin tidak diizinkan oleh kebijakan CORS"}
```

Browser kemudian hanya menampilkan `TypeError: Failed to fetch`.

Selain itu, cookie sesi sebelumnya default ke `SameSite=Strict`. Nilai ini
tidak cocok untuk frontend dan backend yang berada pada site Vercel berbeda.

## Perubahan

- Kebijakan CORS dipindahkan ke `src/lib/corsPolicy.js` agar terisolasi dan
  dapat diuji.
- Origin frontend produksi kanonis
  `https://crisbro-frontend.vercel.app` selalu masuk allowlist minimum.
- `FRONTEND_URL` dan daftar `CORS_ORIGINS` tetap dapat menambah origin secara
  eksplisit.
- Konfigurasi origin hanya menerima URL HTTP/HTTPS tanpa path, query,
  fragment, atau kredensial. Tidak ada wildcard domain.
- Origin asing dan domain lookalike tetap menghasilkan HTTP 403 tanpa header
  `Access-Control-Allow-Origin`.
- Cookie sesi production sekarang default ke `SameSite=None; Secure;
  HttpOnly`. Environment variable masih dapat melakukan override eksplisit.

## Konfigurasi deployment

Pasang pada project **backend**, environment **Production**:

```env
NODE_ENV=production
FRONTEND_URL=https://crisbro-frontend.vercel.app
SESSION_COOKIE_SAME_SITE=none
```

Untuk domain frontend tambahan:

```env
CORS_ORIGINS=https://domain-produksi-lain.com
```

Jangan menambahkan `/api`, `/login`, path lain, atau wildcard. Lakukan
redeploy backend setelah perubahan environment variable. Fallback dalam kode
mencegah domain kanonis terkunci ketika konfigurasi deployment terlewat,
sedangkan environment variable tetap menjadi konfigurasi eksplisit yang
direkomendasikan.

## Output sesudah redeploy

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://crisbro-frontend.vercel.app
Access-Control-Allow-Credentials: true
```

Login dengan kredensial valid kemudian dapat menghasilkan HTTP 200 dan cookie
sesi dengan atribut berikut:

```http
Set-Cookie: crisbar_session=...; Path=/api; HttpOnly; Secure; SameSite=None
```

## Verifikasi

Jalankan test otomatis:

```powershell
npm test
```

Test mencakup preflight origin kanonis tanpa environment variable, penolakan
origin asing/lookalike, dan default cookie production. Hasil implementasi saat
dibuat: **49 test lulus, 0 gagal**.

Setelah deployment, verifikasi endpoint publik:

```powershell
curl.exe -i -X OPTIONS "https://crisbro-backend.vercel.app/api/login" `
  -H "Origin: https://crisbro-frontend.vercel.app" `
  -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: content-type"
```

Jangan menaruh password asli pada dokumentasi, log, atau perintah verifikasi
yang disimpan di shell history.
