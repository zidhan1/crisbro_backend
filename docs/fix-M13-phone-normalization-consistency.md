# M-13 (MEDIUM) — Konsistensi normalisasi nomor telepon antara login & registrasi

Status: **Fixed**
File terdampak: `src/lib/phoneNumber.js` (baru), `src/controllers/authController.js`, `src/services/syncService.js`, `test/authLoginActivation.test.js`, `docs/fix-M12-automated-tests-ci-gate.md` (koreksi)

## 1. Masalah

`login()` di `authController.js` mencocokkan nomor telepon dengan **exact
match ke satu bentuk normalisasi**:

```js
const phone_number = normalizePhone(req.body.phone_number); // -> "8xxx"
const credentials = await prisma.user.findUnique({
  where: { phone_number },   // <- HARUS persis sama dengan yang tersimpan
  select: { id: true, role: true, password_hash: true, activation_status: true },
});
```

Sementara `register()` di file yang SAMA mencari lewat **semua kemungkinan
varian** nomor:

```js
const user = await prisma.user.findFirst({
  where: { phone_number: { in: phoneVariants(phone_number) } }, // 8xxx / 08xxx / 62xxx
  ...
});
```

Kalau ada baris `User.phone_number` yang tersimpan **tidak** dalam bentuk
kanonik `8xxx` (data lama, edit manual, atau bug penulisan di jalur lain
di masa depan), `login()` akan gagal untuk akun itu — bahkan dengan
password yang benar — sementara `register()`/pencarian lain tetap
menemukannya. Kegagalan seperti ini nyaris mustahil dilacak dari sisi
pengguna ("saya yakin password saya benar"), apalagi pesannya memang
sengaja diseragamkan untuk semua jenis penolakan login (desain
anti-enumerasi) — jadi tidak ada petunjuk sama sekali soal penyebab
sebenarnya.

## 2. Verifikasi sebelum menulis kode: format tersimpan di database produksi

Rekomendasi laporan eksplisit meminta verifikasi dulu, bukan asumsi. Query
langsung (read-only) ke database produksi:

```sql
SELECT COUNT(*) FROM "User"
WHERE phone_number IS NOT NULL AND phone_number !~ '^8[0-9]+$'
```

**Hasil: 0 dari 18.333 user dengan `phone_number` yang menyimpang dari
bentuk kanonik `8xxx`.** Seluruh data produksi saat ini memang sudah
konsisten — masuk akal, karena SEMUA jalur yang menulis `phone_number`
(sync Runchise, admin panel, dst) sudah memanggil fungsi `normalizePhone`
yang sama secara logika (walau digandakan di beberapa file, lihat bagian
3.2) sebelum menyimpan.

**Kesimpulan:** ini BUKAN bug yang saat ini sedang membuat akun nyata gagal
login — tapi kerentanan STRUKTURAL yang nyata: tidak ada jaminan di level
kode bahwa hal itu akan tetap benar selamanya. `login()` yang exact-match
adalah satu-satunya jalur di seluruh backend yang TIDAK memberi toleransi
sama sekali terhadap penyimpangan format, padahal semua jalur pencarian
nomor telepon LAIN (register, sync customer) sudah dirancang toleran. Fix
yang tepat adalah menghilangkan asimetri ini, bukan cuma mencatat "saat ini
aman".

## 3. Perbaikan

### 3.1 `login()` sekarang mencari lewat `phoneVariants`, bukan exact match

```js
// M-13: findFirst + phoneVariants (bukan findUnique + exact match) --
// findUnique juga tidak mendukung filter `in`, jadi method-nya ikut
// berubah. Properti waktu-respons seragam (anti-enumerasi) yang sudah
// didesain di sini tidak berubah: tetap satu query, bcrypt.compare tetap
// selalu dijalankan di bawah terlepas dari hasil query.
const credentials = await prisma.user.findFirst({
  where: { phone_number: { in: phoneVariants(phone_number) } },
  select: { id: true, role: true, password_hash: true, activation_status: true },
});
```

### 3.2 Duplikasi `normalizePhone`/`phoneVariants` dikonsolidasi ke satu modul

Sebelum perbaikan ini, `normalizePhone`/`phoneVariants` (logika identik
byte-per-byte) digandakan terpisah di `authController.js` **dan**
`syncService.js`. Duplikasi semacam inilah yang membuka celah bug seperti
M-13 di tempat pertama: dua salinan bisa diam-diam berbeda kalau salah
satu diubah tanpa mengubah yang lain. Dikonsolidasi ke
`src/lib/phoneNumber.js`, diimpor oleh kedua file:

```js
// src/lib/phoneNumber.js
function normalizePhone(raw) { ... }   // -> "8xxxxxxxx"
function phoneVariants(normalizedPhone) { ... }  // -> [8xxx, 08xxx, 62xxx]
module.exports = { normalizePhone, phoneVariants };
```

**`adminLoyaltyController.js`'s `normalizePhone` SENGAJA TIDAK
dikonsolidasikan** — versi itu membungkus `parseOptionalString()` lebih
dulu (validasi tipe + panjang maksimum + pesan error bergaya admin panel)
sebelum melakukan normalisasi digit yang sama, jadi bukan pengganti
drop-in yang aman untuk dua fungsi murni di atas. File itu juga tidak
melakukan pencarian berbasis varian (hanya menulis nilai kanonik saat
create/update), sehingga tidak terkena inkonsistensi query yang jadi inti
laporan ini.

## 4. Verifikasi

### Query database produksi (bagian 2) — sudah ditampilkan di atas.

### Test otomatis — termasuk temuan penting soal metodologi verifikasi

Saat menambahkan test untuk perbaikan ini, ditemukan bahwa metode
verifikasi "tanpa DATABASE_URL" yang dipakai di dokumentasi M-12
**menyesatkan**: `@prisma/client` di proyek ini memuat `.env` dari disk
lewat `prisma.config.ts` (`import "dotenv/config"`), sehingga
meng-**unset** `DATABASE_URL` di shell TIDAK benar-benar mencegah Prisma
terhubung ke database produksi sungguhan — ia tetap membaca `.env` secara
independen dari environment variable proses Node. Ini terungkap saat satu
test lama (`authLoginActivation.test.js`) yang lupa di-update untuk
memakai method mock yang baru (`findFirst`, bukan lagi `findUnique`) tetap
"lolos" untuk 3 dari 4 skenario — bukan karena mock-nya bekerja, tapi
karena secara kebetulan query yang TIDAK ter-mock benar-benar mengenai
database produksi dan mengembalikan hasil yang (kebetulan) sesuai
ekspektasi test.

**Metode verifikasi yang benar-benar membuktikan isolasi test:** set
`DATABASE_URL` ke alamat yang SENGAJA tidak bisa dihubungi, bukan
meng-unset-nya:

```
$ DATABASE_URL="postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1" \
  DIRECT_URL="postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1" \
  npm test
...
1..33
# tests 33
# suites 0
# pass 33
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 902.8201
```

Dengan `DATABASE_URL` yang genuinely tidak bisa dihubungi, **satu saja**
panggilan Prisma yang lupa di-mock akan gagal cepat dan keras (connection
refused/timeout dalam hitungan detik, bukan diam-diam sukses) — 33/33 tetap
lolos dalam < 1 detik total membuktikan seluruh panggilan Prisma yang
benar-benar dieksekusi memang sudah ter-mock dengan benar, bukan kebetulan
menyentuh database sungguhan.

Test baru yang ditambahkan (`authLoginActivation.test.js`, sekarang 9 test,
naik dari 8):

```
ok 4 - login: mencari lewat SEMUA varian nomor (8xxx/08xxx/62xxx), bukan cuma satu bentuk (bug M-13 asli)
```

Menguji langsung bahwa `login()` dengan input `'081234567890'` (format
dengan awalan 0) membangun query `where.phone_number.in` berisi ketiga
variannya (`81234567890`, `081234567890`, `6281234567890`) — bukan cuma
satu bentuk seperti versi lama. Test "kredensial benar" yang sudah ada
juga diperbarui untuk memverifikasi hal yang sama di jalur sukses, plus
memastikan query TAHAP KEDUA (memuat profil lengkap by `id`, tidak
berubah oleh perbaikan ini) tetap memakai `findUnique` seperti semula.

### Syntax check & module load

```
$ node --check src/lib/phoneNumber.js src/controllers/authController.js src/services/syncService.js test/authLoginActivation.test.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
LOAD OK
```

### Diff summary

```
 src/lib/phoneNumber.js               (baru, 33 baris)
 src/controllers/authController.js    (+import, -16 baris duplikat, query login diubah)
 src/services/syncService.js          (+import, -16 baris duplikat)
 test/authLoginActivation.test.js     (mock diperbaiki + 1 test baru)
 docs/fix-M12-automated-tests-ci-gate.md  (koreksi klaim metodologi verifikasi)
```

## 5. Yang TIDAK berubah

- Format kanonik penyimpanan (`8xxxxxxxx`) — tidak berubah, terverifikasi
  sudah konsisten 100% di data produksi.
- `register()` — sudah benar sejak awal (memakai `phoneVariants`), tidak
  disentuh.
- Query kedua di `login()` (memuat profil lengkap lewat `findUnique({
  where: { id } })`) — tidak berubah, itu pencarian by primary key, bukan
  by nomor telepon.
- `adminLoyaltyController.js`'s `normalizePhone` — sengaja tidak
  dikonsolidasikan (lihat bagian 3.2 untuk alasan).
- Properti keamanan anti-enumerasi `login()` (respons/status seragam
  untuk nomor tidak terdaftar, password salah, dan akun belum aktivasi) —
  tetap dipertahankan persis, hanya method query-nya yang berubah.
- Skema database — tidak ada migration baru.

## 6. Dampak

Sebelum perbaikan ini, `login()` adalah SATU-SATUNYA jalur pencarian nomor
telepon di backend yang tidak toleran terhadap penyimpangan format
penyimpanan — sebuah asimetri struktural yang bisa mendiamkan bug
penulisan data di masa depan sampai muncul sebagai laporan "tidak bisa
login padahal password benar" yang sulit dilacak. Sekarang seluruh jalur
pencarian nomor telepon (`login`, `register`, sync customer) konsisten
memakai `phoneVariants`, dan implementasi normalisasinya bersumber dari
satu modul yang sama.
