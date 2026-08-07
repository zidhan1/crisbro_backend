# L-3 (LOW) — Klasifikasi error via substring

Status: **Fixed**

File terdampak:

- `src/controllers/adminLoyaltyController.js`
- `src/lib/validationError.js` (baru)
- `test/adminLoyaltyValidationError.test.js` (baru)

## 1. Masalah

`handleError` sebelumnya menganggap setiap error yang pesannya memuat kata
`harus` atau `wajib` sebagai kesalahan input dan mengirimkannya sebagai HTTP
400:

```js
function handleError(res, error) {
  if (error.message?.includes('harus') || error.message?.includes('wajib')) {
    return badRequest(res, error.message);
  }

  // ...
}
```

Klasifikasi berdasarkan teks tidak menunjukkan asal maupun kategori error.
Akibatnya, error internal seperti `Koneksi database harus tersedia` salah
diklasifikasikan sebagai request yang buruk. Pesan internal tersebut juga
terkirim mentah kepada client.

## 2. Kondisi sebelum perbaikan

Contoh error internal:

```js
throw new Error('Koneksi database harus tersedia');
```

Output lama:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"message":"Koneksi database harus tersedia"}
```

Masalah dari output tersebut:

- status 400 keliru karena request client belum tentu salah;
- kegagalan server tidak tercatat sebagai HTTP 5xx pada metrik;
- detail internal dapat bocor kepada client;
- perubahan redaksi pesan dapat mengubah status HTTP tanpa perubahan tipe
  kegagalan.

## 3. Perbaikan

### 3.1 Tipe validasi eksplisit

`src/lib/validationError.js` mendefinisikan error khusus:

```js
class ValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ValidationError';
  }
}
```

Semua helper parser di `adminLoyaltyController.js` sekarang melempar
`ValidationError`, misalnya:

```js
throw new ValidationError(`${fieldName} harus berupa integer positif`);
```

Ini mencakup validasi integer, boolean, string, email, role, tanggal, angka,
status, gender, dan field wajib `owner_location_id`.

### 3.2 `handleError` memeriksa tipe, bukan isi pesan

Implementasi baru:

```js
function handleError(res, error) {
  if (error instanceof ValidationError) {
    return badRequest(res, error.message);
  }

  // pemetaan Prisma tetap sama; error lain masuk server-error handler
}
```

Pemetaan error Prisma tidak berubah:

| Tipe/kode error | HTTP status |
|---|---:|
| `ValidationError` | 400 |
| Prisma `P2002` | 409 |
| Prisma `P2003` | 400 |
| Prisma `P2025` | 404 |
| Error tak terduga lainnya | 500 |

## 4. Output setelah perbaikan

### Input client tidak valid

Contoh `search` berupa object, padahal harus string:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"message":"search harus berupa string"}
```

### Error internal yang memuat `harus`/`wajib`

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "message":"Terjadi kesalahan pada server. Sebutkan kode error berikut bila menghubungi admin.",
  "error_id":"a1b2c3d4"
}
```

Pesan asli tetap ditulis ke log server bersama `error_id`, tetapi tidak
ditampilkan kepada client.

## 5. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Dasar klasifikasi validasi | Substring `harus`/`wajib` | `instanceof ValidationError` |
| Validasi input | HTTP 400 | HTTP 400 |
| Error internal berisi `harus`/`wajib` | Salah menjadi HTTP 400 | HTTP 500 |
| Pesan internal ke client | Dapat bocor | Diganti pesan generik + `error_id` |
| Stabilitas terhadap perubahan redaksi | Rendah | Tinggi; status ditentukan oleh tipe |
| Keterukuran error server | Tercampur ke metrik 4xx | Tercatat sebagai 5xx |

## 6. Verifikasi otomatis

Test regresi mencakup:

1. error dari parser bertipe `ValidationError` tetap menghasilkan HTTP 400;
2. error internal dengan kata `harus` menghasilkan HTTP 500;
3. error internal dengan kata `wajib` menghasilkan HTTP 500;
4. response 500 memakai pesan generik dan `error_id`, bukan pesan internal.

Perintah verifikasi:

```text
npm test
node --check src/controllers/adminLoyaltyController.js
node --check src/lib/validationError.js
node --check test/adminLoyaltyValidationError.test.js
```

## 7. Panduan pengembangan berikutnya

- Gunakan `ValidationError` hanya untuk input client yang tidak valid dan
  aman ditampilkan sebagai HTTP 400.
- Jangan menentukan status HTTP dari kata tertentu di dalam `error.message`.
- Biarkan error dependency, database, konfigurasi, dan kegagalan tak terduga
  masuk ke `respondWithServerError` agar detail hanya berada di log server.
- Tambahkan pemetaan eksplisit bila ada kategori domain baru yang memang
  memerlukan status HTTP khusus.

Tidak ada perubahan database, migration, dependency, environment variable,
atau bentuk response sukses pada perbaikan ini.
