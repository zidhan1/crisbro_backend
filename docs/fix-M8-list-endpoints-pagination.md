# M-8 (MEDIUM) — Beberapa list endpoint tanpa pagination; listRedemptions menyembunyikan data > 200

Status: **Fixed**
File terdampak (backend): `src/controllers/adminLoyaltyController.js`, `src/routes/adminLoyaltyRoutes.js`
File terdampak (frontend): `src/lib/admin.ts`, `src/features/admin/AdminPage.tsx`

## 1. Masalah

Enam endpoint admin di `adminLoyaltyController.js` mengambil data tanpa
batas atau dengan batas yang tidak bisa dilewati:

| Endpoint | Masalah |
|---|---|
| `listAdminUsers` | `findMany` tanpa `take` sama sekali |
| `listRewards` | `findMany` tanpa `take` sama sekali |
| `listRedeemItems` | `findMany` tanpa `take` sama sekali |
| `listRedeemCategories` | `findMany` tanpa `take` sama sekali |
| `listRedemptions` | `take: 200` **tanpa `skip`** — baris ke-201 dan seterusnya **tidak akan pernah terlihat**, berapa pun jumlah redemption yang ada. Ini bug korektness, bukan cuma performa: tidak ada cara meminta halaman berikutnya sama sekali. |
| `listCustomerSalesTransactionReports` | Sudah dipaginasi untuk data laporannya sendiri, tapi di **setiap** request (setiap ganti halaman/filter) juga menjalankan `distinct` scan atas seluruh `CustomerSalesTransactionReport` — tabel terbesar di database ini — hanya untuk mengisi dropdown filter outlet yang isinya sama sekali tidak bergantung pada halaman/filter yang sedang dilihat. |

## 2. Analisis skala data (sebelum memutuskan cara memperbaiki)

Saya cek jumlah baris riil di database produksi untuk menentukan endpoint
mana yang benar-benar butuh pagination sungguhan (dengan UI halaman) versus
mana yang cukup diberi batas pengaman:

```
admin_marketing_users: 3
rewards: 0
redeemItems: 25
redeemCategories: 1
redemptions: 0
```

`listAdminUsers`, `listRewards`, `listRedeemItems`, `listRedeemCategories`
adalah data **konfigurasi yang dikelola manual** satu-per-satu lewat panel
admin (akun staf, katalog reward, kategori/item menu redeem) — bukan data
transaksional yang tumbuh mengikuti aktivitas customer. Realistis tidak
akan pernah mencapai ribuan baris. `listRedemptions` sebaliknya adalah data
transaksional (satu baris per penukaran reward customer) yang secara
desain akan terus bertambah.

Saya juga cek pemakaian di frontend: `adminApi.redemptions()` dan
`adminApi.updateRedemptionStatus()` ternyata **belum dipanggil di mana pun**
di `AdminPage.tsx` — fitur UI-nya belum pernah dibangun/dihubungkan. Ini
artinya mengubah bentuk respons `listRedemptions` **tidak berisiko
mematahkan tampilan yang sedang dipakai**, karena memang belum ada yang
memakainya.

**Keputusan desain berdasarkan analisis ini:**
- `listAdminUsers`, `listRewards`, `listRedeemItems`, `listRedeemCategories`
  → cukup diberi `take` sebagai **jaring pengaman** (bukan pagination UI
  sungguhan), karena datanya memang genuinely kecil dan terbatas.
  Mengubah bentuk responsnya jadi amplop `{items,...}` untuk data sekecil
  ini hanya menambah kerumitan UI tanpa manfaat nyata.
- `listRedemptions` → **pagination sungguhan** (page/limit/skip + amplop
  respons), karena ini bug korektness yang eksplisit disebut laporan, dan
  datanya transaksional (akan terus bertambah begitu fitur redeem lokal
  dipakai lagi).
- `listCustomerSalesTransactionReports` → daftar outlet dipindah ke
  endpoint terpisah, dipanggil sekali oleh frontend.

## 3. Perbaikan

### 3.1 Batas pengaman untuk data konfigurasi kecil

```js
// listAdminUsers, listRewards, listRedeemCategories, listRedeemItems
const users = await prisma.user.findMany({
  // ...
  take: 1000,
});
```

Setiap `findMany` diberi komentar yang menjelaskan alasannya secara
eksplisit (data dikelola manual, bukan data transaksional) supaya
keputusan ini tidak perlu ditebak ulang oleh pembaca kode berikutnya.

### 3.2 `listRedemptions` — pagination sungguhan

```js
async function listRedemptions(req, res) {
  // ...validasi status...

  const page = parsePositiveInt(req.query.page ?? 1, 'page');
  const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 200);
  const where = status ? { status } : {};

  const total = await prisma.rewardRedemption.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const clampedPage = Math.min(page, totalPages);

  const redemptions = await prisma.rewardRedemption.findMany({
    where,
    include: { reward: {...}, customer: {...} },
    orderBy: { id: 'desc' },
    skip: (clampedPage - 1) * limit,
    take: limit,
  });

  res.json({ items: redemptions, page: clampedPage, limit, total, total_pages: totalPages });
}
```

Pola `{items, page, limit, total, total_pages}` ini **bukan pola baru** —
persis sama dengan yang sudah dipakai `listAdminCustomers` dan
`listAdminActivityLogs` di file yang sama, jadi konsisten dengan konvensi
yang sudah ada di codebase.

### 3.3 `listCustomerSalesTransactionReports` — outlet dipindah ke endpoint sendiri

Query `distinct` outlet dihapus dari fungsi ini (dan dari `$transaction`
yang membungkusnya bersama query laporan), dipindah ke fungsi baru:

```js
async function listCustomerSalesTransactionReportOutlets(req, res) {
  try {
    const outletRows = await prisma.customerSalesTransactionReport.findMany({
      where: { nama_outlet: { not: null } },
      distinct: ['nama_outlet'],
      select: { nama_outlet: true },
      orderBy: { nama_outlet: 'asc' },
    });
    res.json(outletRows.map((row) => row.nama_outlet).filter(Boolean));
  } catch (error) {
    handleError(res, error);
  }
}
```

Route baru: `GET /admin/customer-sales-transaction-reports/outlets`
(role `adminOrMarketing`, sama seperti endpoint laporannya).

### 3.4 Frontend — mengikuti kontrak API yang berubah

- `lib/admin.ts`: `CustomerSalesTransactionReportPage` tidak lagi punya
  field `outlets`; ditambah fungsi
  `customerSalesTransactionReportOutlets()` yang memanggil endpoint baru;
  `redemptions()` diubah menerima `{status, page, limit}` dan
  mengembalikan tipe amplop baru `RedemptionPage` (bukan `Redemption[]`
  lagi) — aman karena belum ada pemanggil di UI.
- `AdminPage.tsx`: daftar outlet sekarang dimuat **sekali** lewat
  `loadSalesTransactionOutlets()` (dijaga ref `salesTransactionOutletsLoaded`
  supaya tidak terulang), dipanggil bersamaan dengan `loadSalesTransactions()`
  hanya saat tab "sales-transactions" pertama kali dibuka — bukan di setiap
  `loadSalesTransactions()` yang terjadi tiap kali admin ganti
  halaman/filter.

## 4. Verifikasi

### `listRedemptions` — bukti korektness (bukan cuma baca kode)

Dibuat 3 baris `RewardRedemption` sintetis, lalu diminta dengan `limit=2`
untuk membuktikan halaman kedua bisa menjangkau baris yang **dulu tidak
mungkin terlihat** (di versi lama, `take:200` tanpa `skip` berarti tidak
ada mekanisme apa pun untuk melihat baris di luar batas):

```
Created 3 RewardRedemption rows for 3 synthetic customers

=== page=1, limit=2 ===
items.length: 2 | page: 1 | limit: 2 | total: 3 | total_pages: 2

=== page=2, limit=2 (baris yang TIDAK PERNAH terlihat di versi lama) ===
items.length: 1 | page: 2

=== default (tanpa page/limit di query) tetap jalan seperti sebelumnya ===
items.length: 3 | total: 3
```

Mekanismenya (skip/take + total/total_pages) sama persis dipakai berapa
pun jumlah barisnya — pengujian dengan 3 baris cukup membuktikan bug
struktural (tidak pernah ada `skip`) sudah tertutup; jumlah barisnya tidak
mengubah cara kerja perbaikan.

### `listCustomerSalesTransactionReports` / `listCustomerSalesTransactionReportOutlets`

```
=== listCustomerSalesTransactionReports: field outlets HARUS TIDAK ADA lagi ===
response keys: [ 'items', 'page', 'limit', 'total', 'total_pages' ]
outlets field masih ada? false

=== listCustomerSalesTransactionReportOutlets: endpoint baru ===
response type: array
jumlah outlet: 29
contoh isi: [ 'Antapani', 'Binus', 'Cihanjuang', 'Cisitu', 'Dramaga' ]
```

Field `outlets` sudah tidak ada lagi di respons laporan (sesuai jumlah
outlet Crisbar yang disebut di komentar-komentar lain di codebase ini —
29 outlet), dan endpoint baru mengembalikan daftar yang sama secara
terpisah.

### Endpoint dengan batas pengaman

```
listAdminUsers      -> status: 200 | count: 3
listRewards         -> status: 200 | count: 0
listRedeemCategories-> status: 200 | count: 1
listRedeemItems     -> status: 200 | count: 25
```

Semua tetap mengembalikan seluruh data yang ada (jauh di bawah batas
1000), tidak ada regresi.

### TypeScript check (frontend)

Dibandingkan sebelum/sesudah perubahan untuk memastikan tidak ada error
tipe baru yang diperkenalkan:

```
$ git stash && npx tsc --noEmit -p tsconfig.json | wc -l
22   # (22 baris error PRA-EXISTING, tidak terkait perubahan ini)

$ git stash pop && npx tsc --noEmit -p tsconfig.json | wc -l
22   # (persis sama -- nol error baru)
```

### Syntax check & module load (backend)

```
$ node --check src/controllers/adminLoyaltyController.js && node --check src/routes/adminLoyaltyRoutes.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
module type: function LOAD OK
```

### Diff summary

```
Backend:
 src/controllers/adminLoyaltyController.js | 90 ++++++++++++++++++++++++-------
 src/routes/adminLoyaltyRoutes.js          |  9 ++++
 2 files changed, 81 insertions(+), 18 deletions(-)

Frontend:
 src/features/admin/AdminPage.tsx | 24 ++++++++++++++++++++++--
 src/lib/admin.ts                 | 33 ++++++++++++++++++++++++++++++---
 2 files changed, 52 insertions(+), 5 deletions(-)
```

## 5. Yang TIDAK berubah

- `listAdminCustomers`, `listAdminActivityLogs`,
  `listCustomerSalesTransactionReports` (bagian laporannya sendiri) —
  sudah dipaginasi dengan benar sebelumnya, tidak disentuh selain
  menghapus query outlet dari `listCustomerSalesTransactionReports`.
- Skema database — tidak ada migration baru.
- Endpoint create/update/delete di `adminLoyaltyController.js` — tidak
  disentuh, hanya endpoint list (`GET`) yang diubah.
- `updateRedemptionStatus` — tidak disentuh (sudah diperbaiki di M-5,
  tidak terkait masalah pagination).
