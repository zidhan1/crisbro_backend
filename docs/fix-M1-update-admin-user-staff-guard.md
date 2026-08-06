# M-1 (MEDIUM) — `updateAdminUser` dapat memodifikasi akun customer

Status: **Fixed**

File terdampak:

- `src/controllers/adminLoyaltyController.js`
- `test/updateAdminUserAccess.test.js`

Route terdampak: `PUT /api/admin/users/:id`

Kategori: **Kontrol Akses, Privilege Escalation, Mass Assignment**

## 1. Masalah

Menu pengelolaan user dimaksudkan khusus untuk akun staff dengan role `admin`
atau `marketing`. Hal tersebut sudah terlihat pada `listAdminUsers`:

```js
where: {
  role: { in: ['admin', 'marketing'] },
}
```

`deleteAdminUser` juga menolak target yang memiliki relasi customer. Namun,
sebelum perbaikan `updateAdminUser` langsung menjalankan update berdasarkan ID
tanpa memastikan target merupakan staff:

```js
const user = await prisma.user.update({
  where: { id },
  data,
});
```

Admin yang mengetahui ID user customer dapat mengirim:

```http
PUT /api/admin/users/42
Content-Type: application/json

{
  "role": "admin"
}
```

Target customer kemudian dapat berubah menjadi admin. Jalur yang sama juga
dapat mengganti email, nomor telepon, atau password customer tanpa melalui
alur pengelolaan customer.

## 2. Dampak

- Akun customer dapat dipromosikan menjadi `admin` atau `marketing`.
- Identitas login dan password customer dapat diubah diam-diam.
- Filter pada halaman daftar staff tidak berfungsi sebagai kontrol akses,
  karena penyerang dapat memanggil endpoint langsung dengan ID arbitrary.
- Audit log lama baru ditulis setelah mutasi berhasil, bukan memblokir target
  yang tidak sah.
- Perubahan role tidak mencabut JWT lama. Karena claim role berada di JWT,
  downgrade admin ke marketing dapat tetap memiliki claim admin sampai sesi
  berakhir.

## 3. Kondisi sebelum perbaikan

```text
PUT /admin/users/:id
        │
        ▼
Parse field email/phone/password/role
        │
        ▼
prisma.user.findUnique({ id })
        │
        ▼
prisma.user.update({ id, data })
        │
        └── Tidak ada pemeriksaan role target/customer relation
```

Contoh request berbahaya:

```json
{
  "role": "admin",
  "password": "password-baru"
}
```

Contoh output lama terhadap ID customer:

```http
HTTP/1.1 200 OK

{
  "id": 42,
  "email": "customer@example.com",
  "role": "admin"
}
```

## 4. Perbaikan

### 4.1 Guard target staff sebelum hashing dan mutasi

Target dibaca terlebih dahulu bersama relasi customer:

```js
const before = await prisma.user.findUnique({
  where: { id },
  select: {
    id: true,
    role: true,
    customer: { select: { id: true } },
  },
});
```

Update hanya boleh dilanjutkan jika:

```text
before.role ∈ { admin, marketing }
AND
before.customer IS NULL
```

Guard dijalankan sebelum password diproses dengan bcrypt. Request terhadap
customer tidak menghabiskan CPU hashing dan tidak masuk transaksi mutasi.

### 4.2 Whitelist field request

Field yang diizinkan hanya:

```text
email
phone_number
password
role
```

Request yang membawa field lain ditolak seluruhnya. Field tidak dikenal tidak
diabaikan diam-diam agar typo atau percobaan mass assignment dapat diketahui
caller.

Contoh:

```http
PUT /api/admin/users/42
Content-Type: application/json

{ "activation_status": "active" }
```

Output:

```http
HTTP/1.1 400 Bad Request

{ "message": "Field tidak diizinkan: activation_status" }
```

### 4.3 Validasi role tetap terbatas

Nilai role hanya dapat berupa:

```text
admin
marketing
```

Nilai `customer`, `superadmin`, atau string lain ditolak oleh
`parseAdminUserRole`.

### 4.4 Guard diulang secara atomik pada query mutasi

Pemeriksaan awal saja memiliki risiko time-of-check/time-of-use: target dapat
berubah setelah `findUnique` tetapi sebelum update. Karena itu kondisi target
diulang pada `updateMany` di dalam transaksi:

```js
await tx.user.updateMany({
  where: {
    id,
    role: { in: ['admin', 'marketing'] },
    customer: { is: null },
  },
  data,
});
```

Jika count bukan satu, transaksi tidak melakukan pencabutan sesi dan endpoint
mengembalikan conflict:

```http
HTTP/1.1 409 Conflict

{
  "message": "Target berubah saat diproses; silakan muat ulang dan coba lagi"
}
```

### 4.5 Sesi dicabut ketika credential keamanan berubah

Jika password atau role berubah, seluruh sesi target dihapus dalam transaksi
yang sama:

```js
await tx.session.deleteMany({ where: { user_id: id } });
```

Ini memastikan:

- password lama tidak memiliki sesi aktif tersisa;
- downgrade role segera berlaku;
- JWT dengan claim role lama tidak dapat dipakai lagi;
- update user dan pencabutan sesi bersifat atomik.

Perubahan email atau nomor telepon saja tidak mencabut sesi karena tidak
mengubah password maupun privilege.

### 4.6 Audit log dipertahankan

Update staff yang sah tetap menulis `update_admin_user`. Metadata sekarang juga
mencatat:

```json
{
  "changed_fields": ["role"],
  "sessions_revoked": true
}
```

`password_hash` tetap disanitasi oleh layanan audit dan tidak pernah ditulis
dalam bentuk plaintext.

## 5. Alur setelah perbaikan

```text
PUT /admin/users/:id
        │
        ├── Tolak field di luar whitelist
        │
        ├── Ambil target + customer relation
        │
        ├── 404 bila target tidak ditemukan
        │
        ├── Tolak bila bukan staff/customer relation ada
        │
        ├── Validasi field dan self-role guard
        │
        ▼
Transaksi database
        ├── updateMany dengan guard role + customer IS NULL
        ├── cabut sesi bila role/password berubah
        └── baca hasil terbaru
        │
        ▼
Tulis audit log dan response
```

## 6. Output setelah perbaikan

### Target customer

```http
PUT /api/admin/users/42

{ "role": "admin" }
```

```http
HTTP/1.1 400 Bad Request

{
  "message": "Hanya akun staff admin atau marketing yang dapat diubah dari menu ini"
}
```

Tidak ada update, hashing password, transaksi, atau audit sukses yang terjadi.

### Target tidak ditemukan

```http
HTTP/1.1 404 Not Found

{ "message": "User tidak ditemukan" }
```

### Update staff yang sah

```http
PUT /api/admin/users/42
Content-Type: application/json

{ "role": "marketing" }
```

```http
HTTP/1.1 200 OK

{
  "id": 42,
  "email": "staff@example.com",
  "phone_number": null,
  "role": "marketing",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-08-06T00:00:00.000Z"
}
```

Semua sesi user 42 dicabut dan login ulang diperlukan.

## 7. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Pemeriksaan target role | Tidak ada | Wajib admin/marketing |
| Pemeriksaan relasi customer | Tidak ada | Wajib `customer IS NULL` |
| Update berdasarkan ID arbitrary | Dapat dilakukan | Ditolak |
| Field request asing | Diabaikan | Ditolak eksplisit |
| Field yang dapat diubah | Dibentuk manual tetapi tanpa reject unknown | Whitelist eksplisit empat field |
| Race guard | Tidak ada | Kondisi diulang pada update atomik |
| Perubahan role/password | Sesi lama tetap aktif | Semua sesi target dicabut |
| Audit | Before/after | Before/after + status session revocation |

## 8. Verifikasi

Test M-1 yang ditambahkan:

```text
ok - menolak promosi akun customer sebelum transaksi atau hashing dijalankan
ok - menolak field di luar whitelist tanpa mengakses target
ok - update role staff memakai guard atomik dan mencabut sesi lama
```

Hasil seluruh test suite backend:

```text
tests 8
pass 8
fail 0
cancelled 0
skipped 0
```

Pemeriksaan tambahan:

```text
node --check src/controllers/adminLoyaltyController.js
node --check test/updateAdminUserAccess.test.js
git diff --check

Exit code: 0
```

Test menggunakan Prisma mock dan tidak membaca atau mengubah database
production.

## 9. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Verifikasi `before.role ∈ (admin, marketing)` | Guard awal dan kondisi atomik `role: { in: [...] }` |
| Cerminkan guard delete | Target dengan relasi customer ditolak |
| Whitelist field | Hanya email, phone_number, password, dan role |
| Cegah privilege lama bertahan | Sesi dicabut saat role/password berubah |
| Buat perubahan terukur | Audit metadata + tiga unit test khusus |

## 10. Yang tidak berubah

- Route tetap admin-only melalui `requireRole('admin')`.
- `listAdminUsers` tetap hanya menampilkan admin dan marketing.
- Admin tetap tidak dapat menurunkan role akunnya sendiri.
- Validasi email, nomor telepon, password minimum, dan duplicate constraint
  tetap berlaku.
- `createAdminUser` dan `deleteAdminUser` tidak berubah.
- Tidak ada perubahan skema atau migration database.

## 11. Checklist deployment

1. Deploy backend tanpa migration database.
2. Uji update email staff dan pastikan sesi tidak dicabut.
3. Uji update password staff dan pastikan login lama mendapat 401.
4. Uji downgrade admin lain ke marketing dan pastikan token lama tidak berlaku.
5. Kirim ID customer langsung ke endpoint dan pastikan mendapat 400.
6. Kirim field di luar whitelist dan pastikan seluruh request ditolak.
7. Pantau audit action `update_admin_user` dan metadata `sessions_revoked`.
