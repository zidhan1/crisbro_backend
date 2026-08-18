# M-7 (MEDIUM) — deleteAdminCustomer mungkin tak menghapus semua baris terkait

Status: **Fixed**

> **Kebijakan saat ini (setelah H-4/M-7 privacy retention):**
> `deleteAdminCustomer` menghapus relasi `RESTRICT` dan menganonimkan
> snapshot PII pada `CustomerSalesTransactionReport` serta
> `RunchisePosRewardRedemption` sebelum customer dihapus. Baris POS tetap
> dipertahankan untuk audit, tetapi `customer_name`,
> `customer_phone_number`, `raw`, dan `customer_id` tidak lagi menyimpan
> identitas customer. Bagian “sebelum perbaikan” di bawah adalah sejarah,
> bukan deskripsi perilaku kode saat ini.
File terdampak: `src/controllers/adminLoyaltyController.js` (`deleteAdminCustomer`)

## 1. Sebelum perbaikan

```js
async function deleteAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const beforeCustomer = await getCustomerAuditSnapshot(id);
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { user_id: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    await prisma.$transaction([
      prisma.pointHistory.deleteMany({ where: { customer_id: id } }),
      prisma.rewardRedemption.deleteMany({ where: { customer_id: id } }),
      prisma.customerPoint.deleteMany({ where: { customer_id: id } }),
      prisma.customerLocation.deleteMany({ where: { customer_id: id } }),
      prisma.customer.delete({ where: { id } }),
      prisma.session.deleteMany({ where: { user_id: customer.user_id } }),
      prisma.user.delete({ where: { id: customer.user_id } }),
    ]);

    await recordAdminActivity({ ...action: 'delete_customer'... });
    res.json({ message: 'Customer berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}
```

**Masalah:** transaksi ini secara eksplisit menghapus `PointHistory`,
`RewardRedemption`, `CustomerPoint`, `CustomerLocation`, `Customer`,
`Session`, lalu `User` — tapi ada baris lain di database yang juga
mereferensikan `customer_id`/`user_id` dan **tidak** ikut dibersihkan.
Kalau foreign key yang terlewat itu ternyata `RESTRICT` (bukan `CASCADE`
atau `SET NULL`) di level database, `user.delete()` di akhir transaksi
akan gagal dengan `P2003` (foreign key violation) dan **seluruh transaksi
di-rollback** — customer tidak jadi terhapus sama sekali, tapi tanpa pesan
error yang jelas ke admin tentang penyebabnya.

Laporan menyebut dua kandidat yang mungkin terlewat:
`RunchisePosRewardRedemption` (referensi `customer_id`) dan **token
aktivasi**, dan secara eksplisit meminta verifikasi konfigurasi cascade
yang sebenarnya karena tidak bisa dipastikan hanya dari membaca kode
transaksi ini saja.

## 2. Verifikasi konfigurasi cascade (sebelum menulis perbaikan)

Alih-alih menebak dari `schema.prisma`, saya query langsung katalog
Postgres produksi (`information_schema.referential_constraints`) untuk
melihat `delete_rule` **sesungguhnya** dari setiap foreign key yang
menunjuk ke `Customer` atau `User`:

```
child_table                      | fk_column            | parent_table | delete_rule
----------------------------------+-----------------------+--------------+------------
CustomerLocation                 | customer_id           | Customer     | RESTRICT
CustomerPoint                    | customer_id           | Customer     | RESTRICT
CustomerSalesTransactionReport   | customer_id           | Customer     | SET NULL
PointHistory                     | customer_id           | Customer     | RESTRICT
RewardRedemption                 | customer_id           | Customer     | RESTRICT
RunchisePosRewardRedemption      | customer_id           | Customer     | SET NULL
AccountActivationToken           | user_id               | User         | RESTRICT
AdminActivityLog                 | actor_user_id         | User         | SET NULL
Customer                         | last_updated_by_id    | User         | SET NULL
Customer                         | created_by_id         | User         | SET NULL
Customer                         | user_id               | User         | RESTRICT
Session                          | user_id               | User         | RESTRICT
```

**Kesimpulan yang terkonfirmasi langsung dari database, bukan dugaan:**

- Dugaan di laporan soal `RunchisePosRewardRedemption` **benar** — sudah
  `SET NULL`, aman, tidak perlu perubahan kode (baris histori penjualan
  tetap ada, hanya `customer_id`-nya jadi `NULL`).
- `CustomerSalesTransactionReport`, `AdminActivityLog.actor_user_id`, dan
  `Customer.created_by_id`/`last_updated_by_id` juga semuanya `SET NULL` —
  aman, tidak perlu perubahan.
- **`AccountActivationToken.user_id` adalah `RESTRICT` — dan TIDAK ADA
  `deleteMany` untuk tabel ini di transaksi lama.** Inilah "token
  aktivasi" yang disebut laporan sebagai kemungkinan penyebab masalah —
  dan sekarang terbukti benar-benar itu masalahnya, bukan sekadar
  kemungkinan teoretis.

## 3. Bukti bug (direproduksi dengan data uji sebelum menulis perbaikan)

Setiap customer yang pernah dikirimi tautan aktivasi/reset password —
yaitu **hampir semua customer**, karena ini bagian dari alur normal
pembuatan akun — punya minimal satu baris `AccountActivationToken`. Saya
buat customer + token aktivasi sintetis, lalu jalankan persis urutan
transaksi yang lama:

```
Created customer 18366 user 18385 with 1 AccountActivationToken row

=== Reproduksi bug: transaksi delete versi LAMA ===
GAGAL (sesuai ekspektasi bug): P2003 -
User masih ada setelah transaksi gagal (rollback)? true
```

Terbukti: `deleteAdminCustomer` versi lama gagal total (rollback,
customer TIDAK terhapus) untuk kasus yang sangat umum ini.

## 4. Perbaikan

Satu baris ditambahkan ke transaksi, sebelum `user.delete`:

```js
await prisma.$transaction([
  prisma.pointHistory.deleteMany({ where: { customer_id: id } }),
  prisma.rewardRedemption.deleteMany({ where: { customer_id: id } }),
  prisma.customerPoint.deleteMany({ where: { customer_id: id } }),
  prisma.customerLocation.deleteMany({ where: { customer_id: id } }),
  prisma.customer.delete({ where: { id } }),
  prisma.session.deleteMany({ where: { user_id: customer.user_id } }),
  prisma.accountActivationToken.deleteMany({          // <-- BARU
    where: { user_id: customer.user_id },
  }),
  prisma.user.delete({ where: { id: customer.user_id } }),
]);
```

Ditambah komentar di atas fungsi yang mencatat hasil verifikasi
`delete_rule` di atas secara eksplisit — kalau nanti ada tabel baru yang
mereferensikan `Customer`/`User`, siapa pun yang membaca kode ini punya
daftar acuan lengkap tentang mana yang sudah aman (SET NULL) dan mana yang
butuh `deleteMany` eksplisit (RESTRICT), sesuai rekomendasi "pastikan
konfigurasi cascade konsisten atau tambahkan deleteMany yang hilang" —
kedua-duanya sekarang eksplisit, bukan hanya salah satu.

## 5. Verifikasi setelah perbaikan

Diuji ulang terhadap database produksi dengan skenario yang **lebih
lengkap** dari sekadar token aktivasi — customer sintetis dengan
`CustomerLocation`, `RewardRedemption`, `PointHistory`,
`AccountActivationToken`, **dan** `RunchisePosRewardRedemption` sekaligus
(supaya sekalian membuktikan baris `SET NULL` benar-benar tidak ikut
terhapus, bukan cuma tidak memblokir):

```
Setup lengkap: customer 18368 dengan CustomerLocation, RewardRedemption,
PointHistory, AccountActivationToken, dan RunchisePosRewardRedemption (id 222)

=== Jalankan deleteAdminCustomer (versi SUDAH DIPERBAIKI) ===
status: 200 { message: 'Customer berhasil dihapus' }

=== Verifikasi hasil ===
User terhapus: true
Customer terhapus: true
AccountActivationToken terhapus: true   <- SEBELUMNYA memblokir seluruh transaksi
Session terhapus: true
CustomerLocation terhapus: true
PointHistory terhapus: true
RewardRedemption terhapus: true
CustomerPoint terhapus: true
RunchisePosRewardRedemption TETAP ADA (baris histori penjualan tidak boleh
  ikut hilang), customer_id sekarang: null   <- SET NULL bekerja dengan benar
AdminActivityLog delete_customer tercatat: true
```

Semua baris yang seharusnya terhapus (RESTRICT) benar-benar terhapus, dan
baris yang seharusnya bertahan tapi dilepas tautannya (SET NULL) benar-benar
bertahan dengan `customer_id = NULL` — bukan ikut terhapus dan bukan
memblokir transaksi. Data uji dibersihkan setelahnya dan diverifikasi nol
sisa di database.

### Syntax check & module load

```
$ node --check src/controllers/adminLoyaltyController.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
module type: function LOAD OK
```

### Diff summary

```
 src/controllers/adminLoyaltyController.js | 20 ++++++++++++++++++++
 1 file changed, 20 insertions(+)
```

## 6. Yang TIDAK berubah

- Skema database — tidak ada migration baru. Perbaikan murni menambah satu
  `deleteMany` di kode aplikasi; `delete_rule` yang sudah `SET NULL` untuk
  relasi lain terbukti sudah benar dan tidak perlu diubah.
- Urutan/isi statement lain di transaksi — tidak diubah, hanya disisipi
  satu baris baru.
- `RunchisePosRewardRedemption`, `CustomerSalesTransactionReport`,
  `AdminActivityLog`, `Customer.created_by_id`/`last_updated_by_id` — tidak
  disentuh karena terverifikasi sudah aman (`SET NULL`) langsung dari
  database.
