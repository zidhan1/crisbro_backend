# M-12 (MEDIUM) — Tidak ada test otomatis di backend maupun frontend

Status: **Fixed**
File terdampak (backend): `test/authLoginActivation.test.js`, `test/redemptionStatusTransition.test.js`, `test/upsertCustomerIdempotency.test.js`, `.github/workflows/ci.yml`
File terdampak (frontend): `src/components/ui/select.test.tsx`, `vitest.config.ts`, `vitest.setup.ts`, `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`

## 1. Sebelum perbaikan

Laporan menyebut `backend/package.json` (`script test = error`) dan
frontend tanpa test sama sekali.

**Temuan sebelum menulis kode:** menjalankan `npm test` di backend
ternyata **sudah** memicu 14 test yang lolos (`test/distributedCronLock.test.js`,
`loyaltySummaryProjection.test.js`, `runchiseServiceSafety.test.js`,
`salesTransactionSyncCoverage.test.js`, `updateAdminUserAccess.test.js`) —
infrastruktur testing backend sudah dibangun di commit-commit sebelumnya
dalam sesi ini (mis. saat perbaikan cron/lock), membuat klaim "script test
= error" di laporan sudah usang. **Tapi** tak satu pun dari 14 test itu
menyentuh tiga kategori yang eksplisit diminta laporan: **login/aktivasi**,
**kredit/pemakaian poin**, dan **idempotensi upsert sync** — celah nyata
tetap ada, hanya di tempat yang berbeda dari yang diklaim laporan.

Frontend memang benar-benar tanpa infrastruktur test sama sekali: tidak
ada Vitest, tidak ada `@testing-library`, tidak ada script `test` di
`package.json`.

## 2. Perbaikan

### 2.1 Pola testing yang sudah ada di backend, diikuti apa adanya

`test/updateAdminUserAccess.test.js` (sudah ada) memakai pola: `node:test`
+ `node:assert/strict`, dan me-**mock method Prisma langsung** (menimpa
`prisma.user.findUnique`, `prisma.$transaction`, dst dengan fungsi
tiruan), memanggil fungsi controller/service yang SESUNGGUHNYA dengan
`req`/`res` tiruan, lalu assert pada efek sampingnya. **Tidak** memakai
Prisma test DB sungguhan — seluruhnya mock, sehingga tidak butuh
DATABASE_URL/koneksi apa pun untuk berjalan (dikonfirmasi lewat pengujian
langsung: seluruh 32 test tetap lolos meski `DATABASE_URL` di-unset sama
sekali).

Tiga file test baru mengikuti pola yang SAMA persis, satu per kategori
yang diminta laporan:

### 2.2 `test/authLoginActivation.test.js` — login/aktivasi (8 test)

Menguji `login()` dan `activateAccount()` di `authController.js`:
- Password salah, nomor tidak terdaftar, dan akun `pending_activation`
  ketiganya dibalas **pesan 401 yang identik** (jaminan anti-enumerasi
  yang sengaja dirancang di kode aslinya).
- Login sukses: sesi dibuat dengan `user_id` benar, cookie di-set,
  `password_hash` tidak ikut terkirim ke client.
- `activateAccount`: token tidak valid/kedaluwarsa/sudah dipakai ditolak;
  token sah menjalankan tiga operasi (set password, tandai token
  terpakai, cabut semua sesi lama) dalam satu transaksi.

### 2.3 `test/redemptionStatusTransition.test.js` — kredit/pemakaian poin (7 test)

Menguji `updateRedemptionStatus()` (state machine dari M-5): transisi
valid mendebit/me-refund `available_point` dengan benar dan mencatat
`PointHistory`; transisi `claimed -> pending` (skenario persis bug asli
M-5) ditolak; poin tidak cukup ditolak SEBELUM ada statement tulis yang
jalan; status terminal (`expired`) tidak bisa diubah lagi.

### 2.4 `test/upsertCustomerIdempotency.test.js` — idempotensi upsert sync (3 test)

Menguji `upsertRunchiseCustomersBatch()` (dari C-2): simulasi dua
"sinkronisasi" berturut-turut dengan data customer **persis sama** —
sinkronisasi kedua harus mengenali baris yang sudah ada (status
`'updated'`, `customer_id` SAMA) dan tidak pernah membuat duplikat. Juga
menguji dedup dalam satu halaman (customer yang sama muncul dua kali di
satu respons API Runchise — sengaja diskenariokan pakai data duplikat
alih-alih diasumsikan tidak pernah terjadi).

### 2.5 Frontend: Vitest + React Testing Library dipasang dari nol

```
npm install --save-dev vitest @testing-library/react
  @testing-library/user-event @testing-library/jest-dom jsdom
```

- `vitest.config.ts` — **sengaja terpisah** dari `vite.config.ts` (yang
  dibungkus `@lovable.dev/vite-tanstack-config` khusus untuk build
  TanStack Start/Cloudflare) supaya kompleksitas SSR/build tidak ikut
  masuk ke environment test; cukup plugin React + alias `@/*`.
- `vitest.setup.ts` — polyfill `hasPointerCapture`/`setPointerCapture`/
  `scrollIntoView`/`ResizeObserver` yang tidak diimplementasikan jsdom
  tapi dipakai Radix UI secara internal (tanpa ini, me-render komponen
  Radix di jsdom melempar error runtime yang tidak berhubungan dengan
  bug aplikasi sama sekali).
- `tsconfig.json` — ditambah `vitest/globals` dan
  `@testing-library/jest-dom` ke array `types` supaya matcher seperti
  `toBeInTheDocument()` dikenali TypeScript.
- `package.json` — script `"test": "vitest run"` ditambahkan.

### 2.6 `src/components/ui/select.test.tsx` — jaring pengaman regresi untuk M-10

Test pertama di frontend ini SENGAJA menguji ulang (secara otomatis) apa
yang diverifikasi manual di browser saat M-10 (Select kustom yang dulu
tidak bisa dipakai keyboard): ArrowDown + Enter memilih opsi, Escape
membatalkan tanpa mengubah nilai dan mengembalikan fokus ke trigger, dan
round-trip sentinel untuk opsi bernilai string kosong. Kalau
`select.tsx` suatu saat direfactor dan tanpa sengaja memutus navigasi
keyboard lagi, test ini gagal di CI sebelum sampai ke production.

### 2.7 Gate CI: `.github/workflows/ci.yml` di kedua repo

- **Backend**: `npm ci` + `npm test`. Tidak butuh secret/DATABASE_URL
  apa pun (dikonfirmasi empiris, lihat bagian 2.1).
- **Frontend**: job `test` menjalankan `npm test` (Vitest) sebagai gate;
  job `typecheck` terpisah menjalankan `tsc --noEmit` dengan
  `continue-on-error: true` — **sengaja tidak dijadikan gate keras**
  karena repo ini sudah punya beberapa error tipe pra-existing di luar
  cakupan perbaikan M-12 (lihat bagian 4); dijadikan job informatif dulu
  supaya tidak memblokir PR karena utang teknis yang tidak terkait.

## 3. Verifikasi

### Backend — seluruh suite (14 lama + 18 baru), tanpa DATABASE_URL sama sekali

```
$ env -u DATABASE_URL -u DIRECT_URL -u RUNCHISE_API_KEY npm test
...
1..32
# tests 32
# suites 0
# pass 32
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1546.3733
```

Rincian 18 test baru:

```
test/authLoginActivation.test.js       -> 8 test, semua ok
test/redemptionStatusTransition.test.js -> 7 test, semua ok
test/upsertCustomerIdempotency.test.js  -> 3 test, semua ok
```

### Frontend — Vitest

```
$ npx vitest run
 RUN  v4.1.10 C:/Users/ACER/Downloads/project/crisbar/crisbro-frontend

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  03:39:52
   Duration  7.63s
```

### TypeScript & ESLint (frontend) — dibandingkan dengan baseline

```
$ npx tsc --noEmit -p tsconfig.json | wc -l
22   # persis sama dengan baseline sebelum M-12 (0 error baru dari file test)

$ npx eslint src/components/ui/select.test.tsx vitest.config.ts vitest.setup.ts
(tidak ada output -- 0 error, 0 warning)
```

### Diff summary

```
Backend:
 test/authLoginActivation.test.js        (baru, 293 baris)
 test/redemptionStatusTransition.test.js (baru, 270 baris)
 test/upsertCustomerIdempotency.test.js  (baru, 165 baris)
 .github/workflows/ci.yml                (baru)

Frontend:
 src/components/ui/select.test.tsx (baru)
 vitest.config.ts                  (baru)
 vitest.setup.ts                   (baru)
 .github/workflows/ci.yml          (baru)
 package.json                      (+devDependencies, +script test)
 tsconfig.json                     (+types: vitest/globals, @testing-library/jest-dom)
```

## 4. Yang TIDAK dikerjakan (batasan yang didokumentasikan secara sadar)

- **CI belum benar-benar dijalankan di GitHub** — workflow YAML ditulis
  dan divalidasi secara struktural (indentasi, sintaks) serta seluruh
  perintah di dalamnya (`npm ci`, `npm test`, `tsc --noEmit`) sudah
  diverifikasi berjalan benar secara lokal, tapi menjalankan GitHub
  Actions sungguhan butuh push ke repo GitHub yang di luar jangkauan
  perbaikan ini untuk diverifikasi langsung.
- **22 error TypeScript pra-existing di frontend** (tidak terkait M-12,
  sudah ada sebelum perbaikan ini — lihat dokumentasi M-8/M-9/M-10/M-11
  yang berulang kali mengonfirmasi baseline ini) — sengaja tidak
  diperbaiki di sini karena di luar cakupan "tidak ada test otomatis";
  jadi alasan `typecheck` job di CI frontend dibuat informatif
  (`continue-on-error`), bukan gate keras.
- **Prisma test DB sungguhan** (disebut sebagai opsi di rekomendasi
  laporan) — tidak dipakai. Pola mocking yang sudah established di
  backend terbukti cukup untuk menguji logika bisnis kritis tanpa beban
  provisioning database di CI, dan tetap konsisten dengan test yang
  sudah ada sebelumnya di repo ini.
- **Cakupan test belum menyeluruh** — 18 test baru + 14 test lama
  menutup jalur paling kritis (finansial, keamanan) yang eksplisit
  disebut laporan, bukan seluruh codebase. Ini adalah TITIK AWAL yang
  sengaja diprioritaskan pada risiko tertinggi, sesuai rekomendasi
  laporan ("mulai dari test integrasi jalur kritis"), bukan klaim
  cakupan 100%.

## 5. Yang TIDAK berubah

- 14 test yang sudah ada sebelumnya — tidak disentuh, tetap lolos
  bersama 18 test baru.
- Tidak ada perubahan pada kode aplikasi (controller/service) — murni
  penambahan test dan infrastruktur CI/testing.
- Skema database — tidak ada migration baru; seluruh test backend
  memakai mock, bukan database sungguhan.
