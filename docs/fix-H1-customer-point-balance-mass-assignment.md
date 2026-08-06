# H-1 (HIGH) — Endpoint customer menerima nilai poin & saldo dari body (mass-assignment)

Status: **Fixed**
File terdampak: `src/controllers/adminLoyaltyController.js`, `src/routes/adminLoyaltyRoutes.js`

## 1. Masalah

`createAdminCustomer` dan `updateAdminCustomer` (`POST/PUT /admin/customers`,
dapat diakses role `admin` **dan** `marketing`) menerima `total_point`,
`available_point`, dan `balance` langsung dari body request lalu
menuliskannya ke `CustomerPoint`/`Customer` tanpa validasi tambahan. Poin
bisa ditukar item menu (bernilai rupiah), sehingga:

- Role `marketing` bisa membuat atau mengedit customer lalu men-set
  `available_point` ke nilai berapa pun.
- Tidak ada invariant `available_point ≤ total_point`.
- Tidak ada batas, tidak ada approval.
- Perubahan tercampur dengan field profil biasa (nama, alamat, dst) di
  audit log, bukan tercatat sebagai transaksi poin yang jelas.

## 2. Analisis tambahan: frontend sudah menganggap field ini read-only

Sebelum menulis perbaikan, saya memeriksa `crisbro-frontend/src/routes/admin.tsx`
dan menemukan fakta penting yang mengarahkan desain perbaikan:

- Form edit customer merender `balance`/`total_point`/`available_point`
  sebagai `<ReadOnlyField>` untuk **semua role** (admin maupun marketing) —
  UI tidak pernah memberi kontrol untuk mengubahnya.
- Form create customer tidak menampilkan field ini sama sekali; payload-nya
  selalu mengirim `0` untuk ketiganya.
- **Namun** payload edit tetap MENYERTAKAN `balance`/`total_point`/
  `available_point` (echo nilai yang sedang ditampilkan) di setiap request
  update, untuk field lain apa pun yang diubah (nama, alamat, dst).

Artinya: backend menerima nilai-nilai ini dari SEMUA request edit, meski UI
tidak pernah bermaksud mengubahnya. Kerentanan murni di level API: siapa pun
yang bisa memanggil endpoint langsung (bukan lewat UI) — termasuk marketing
yang sah — bisa mengganti nilai echo tersebut dengan angka sembarang.

Fakta ini menentukan bentuk perbaikan: field-field ini **tidak boleh
ditolak begitu saja** kalau disertakan di body (itu akan mematahkan
penyimpanan perubahan profil biasa untuk SEMUA pengguna, karena payload
edit selalu menyertakannya) — field-field itu harus **diabaikan** dari
endpoint profil, dan percobaan mengubah NILAINYA harus tetap terekam.

## 3. Perbaikan

### 3.1 `createAdminCustomer` — customer baru selalu mulai dari nol

`total_point`/`available_point`/`balance` tidak lagi diterima dari body.
`customer_point` selalu dibuat dengan `total_point: 0, available_point: 0`,
`balance` selalu `0`. Konsisten dengan payload create yang memang selalu
mengirim `0` di frontend.

### 3.2 `updateAdminCustomer` — diabaikan, bukan ditolak, tapi percobaan mutasi direkam

Body **tidak ditolak** kalau menyertakan `balance`/`total_point`/
`available_point` (supaya kompatibel dengan payload existing frontend), tapi
nilainya **tidak pernah diterapkan** — untuk admin maupun marketing.
Sebelum mengabaikan, nilai yang dikirim dibandingkan dengan nilai yang
tersimpan saat ini:

- Kalau **sama** (echo dari UI read-only) → tidak ada yang tercatat,
  perilaku existing tidak berubah sama sekali.
- Kalau **berbeda** (percobaan mutasi asli, sengaja atau lewat request yang
  dibuat manual) → percobaan itu:
  1. **Tetap diabaikan** — nilai poin/saldo tidak berubah.
  2. Di-log lewat `console.warn` dengan `customer_id`, `actor_user_id`,
     `actor_role`, dan nilai yang dicoba vs yang dipertahankan.
  3. Disisipkan ke `metadata.blocked_loyalty_mutation_attempt` pada baris
     `AdminActivityLog` action `update_customer` yang sama — sehingga
     tercatat permanen dan bisa diaudit.

Update field profil lain (nama, alamat, status, dll) tetap berjalan normal
di request yang sama.

### 3.3 Endpoint baru admin-only: `POST /admin/customers/:id/loyalty-adjustment`

Satu-satunya jalur yang sah untuk mengubah poin/saldo customer secara manual.

**Role**: `requireRole('admin')` di level route — marketing tidak punya
akses sama sekali (bukan cuma dibatasi di controller, ditolak sebelum
masuk handler).

**Body**: `{ total_point?, available_point?, balance?, reason }` — `reason`
**wajib** (string, 1-500 karakter), minimal satu dari tiga field nilai
wajib diisi.

**Invariant**: `available_point ≤ total_point` divalidasi terhadap nilai
**efektif** (field yang diubah digabung dengan field yang tidak disentuh),
bukan cuma field yang dikirim — jadi menaikkan `available_point` tanpa
menyentuh `total_point`, atau menurunkan `total_point` di bawah
`available_point` yang berlaku sekarang, sama-sama ditolak (400).

**Transaksi terkontrol, bukan field profil**:
- Setiap perubahan `available_point`/`total_point` menulis satu baris
  `PointHistory` (`type: 'admin_adjustment'`, `points_change` = delta
  `available_point`, `description` = `reason`) — ledger yang sebelumnya
  ada di skema tapi tidak pernah ditulis oleh kode manapun di backend ini.
- Selalu tercatat di `AdminActivityLog` (action `adjust_customer_loyalty`)
  dengan before/after lengkap + `reason` + rincian perubahan per field.
- Dibungkus `prisma.$transaction` — update `CustomerPoint`, update
  `Customer.balance`, dan insert `PointHistory` atomik bersama.

## 4. Verifikasi

Diuji langsung terhadap database produksi (Supabase) memakai customer
sintetis (dibuat & dibersihkan eksplisit, nol sisa diverifikasi setelahnya)
lewat pemanggilan langsung fungsi controller dengan `req`/`res` tiruan
(bukan cuma baca kode):

### `adjustCustomerLoyalty` (endpoint baru)

```
Case 1 (tanpa reason) status: 400 { message: 'reason wajib diisi' }
Case 2 (available_point melebihi total_point) status: 400
  { message: 'available_point tidak boleh melebihi total_point' }
Case 3 (adjustment sah: total_point 100->150, available_point 50->80) status: 200
  customer_point setelah: { total_point: 150, available_point: 80, ... }
  PointHistory ditulis: { points_change: 30, type: 'admin_adjustment',
                           description: 'koreksi manual test' }
  AdminActivityLog ditulis: action 'adjust_customer_loyalty'
Case 4 (tidak ada field yang diisi) status: 400
  { message: 'Isi minimal salah satu dari total_point, available_point, atau balance' }
```

### `updateAdminCustomer` (endpoint profil, role marketing)

```
Case A: kirim balance/total_point/available_point SAMA dengan nilai saat ini
        (echo, seperti yang dikirim frontend) + perubahan nama yang sah
  -> status 200, nama berubah, poin TETAP 100/50, TIDAK ada flag di audit log

Case B: kirim available_point=999999, total_point=999999, balance=999999
        (percobaan mutasi asli oleh role marketing)
  -> status 200 (request tetap diproses untuk field lain)
  -> poin setelah percobaan: TETAP 100/50 (tidak berubah)
  -> saldo setelah percobaan: TETAP 0 (tidak berubah)
  -> console.warn tercatat: "blocked point/balance mutation attempt ..."
  -> AdminActivityLog metadata berisi blocked_loyalty_mutation_attempt
     dengan { attempted: 999999, kept: 100/50/0 } untuk masing-masing field
```

Kedua skenario dibersihkan setelahnya; nol sisa data uji di database.

### Syntax check & module load

```
$ node --check src/controllers/adminLoyaltyController.js && node --check src/routes/adminLoyaltyRoutes.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
module type: function LOAD OK
```

### Diff summary

```
 src/controllers/adminLoyaltyController.js | 244 +++++++++++++++++++++++++-----
 src/routes/adminLoyaltyRoutes.js          |   5 +
 2 files changed, 209 insertions(+), 40 deletions(-)
```

## 5. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Batasi mutasi poin/saldo ke peran admin | Endpoint baru `POST /admin/customers/:id/loyalty-adjustment` di-gate `requireRole('admin')`; endpoint profil (`admin`+`marketing`) tidak bisa mengubah poin/saldo sama sekali, untuk role manapun |
| Validasi invariant | `available_point <= total_point` divalidasi terhadap nilai efektif sebelum statement apa pun dijalankan |
| Catat ke audit log tiap perubahan saldo | `AdminActivityLog` action `adjust_customer_loyalty` untuk perubahan sah; `blocked_loyalty_mutation_attempt` di action `update_customer` untuk percobaan yang diblokir |
| Perlakukan penambahan poin sebagai transaksi terkontrol | Endpoint terpisah, wajib `reason`, menulis `PointHistory` (ledger yang sebelumnya tidak pernah dipakai), dibungkus transaksi DB |

## 6. Yang TIDAK berubah

- Endpoint `GET /admin/customers`, `DELETE /admin/customers/:id`, dan field
  profil lain di `POST/PUT /admin/customers` — tidak disentuh.
- Skema database — tidak ada migration baru; `PointHistory.type` sudah
  berupa kolom `TEXT` bebas (tanpa CHECK constraint), sehingga nilai baru
  `'admin_adjustment'` aman ditambahkan tanpa migration.
- Sinkronisasi poin dari Runchise/POS (`syncCustomerPointsFromStaging`,
  `syncCustomerPoints`) — tetap jadi source of truth utama untuk poin
  sehari-hari; endpoint baru ini murni untuk koreksi manual terkontrol.

## 7. Catatan untuk pengembangan lanjutan (di luar scope perbaikan ini)

- Tidak ada batas nominal per adjustment (mis. maksimum poin per sekali
  koreksi) — belum ditambahkan karena bisa menghalangi koreksi besar yang
  memang sah (mis. memperbaiki kesalahan sync massal). Kalau dibutuhkan,
  batas ini bisa ditambahkan sebagai validasi tambahan di
  `adjustCustomerLoyalty` tanpa mengubah desain endpoint.
- Rekomendasi issue menyebut "alur approval terpisah" sebagai alternatif
  dari sekadar membatasi ke role admin. Perbaikan ini mengambil opsi
  pembatasan role + audit + ledger (lebih sederhana, tidak butuh peran/UI
  approval baru). Approval dua-orang (four-eyes) untuk adjustment besar
  adalah peningkatan lanjutan yang wajar kalau dibutuhkan di masa depan.
