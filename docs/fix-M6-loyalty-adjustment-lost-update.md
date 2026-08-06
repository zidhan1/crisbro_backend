# M-6 (MEDIUM) — Saldo poin ditulis sebagai nilai absolut: rawan lost-update & tanpa invariant

Status: **Fixed**
File terdampak: `src/controllers/adminLoyaltyController.js` (`adjustCustomerLoyalty`)

## 0. Catatan penting soal lokasi bug

Laporan M-6 menunjuk `updateAdminCustomer`. Tapi fungsi itu sudah **tidak
lagi menulis `total_point`/`available_point`/`balance` sama sekali** sejak
perbaikan H-1 (endpoint profil biasa tidak boleh memutasi poin/saldo).
Satu-satunya jalur yang sekarang menulis nilai-nilai itu adalah endpoint
baru yang dibuat di H-1: `adjustCustomerLoyalty`
(`POST /admin/customers/:id/loyalty-adjustment`).

**Bug M-6 tetap nyata** — hanya berpindah lokasi bersama fiturnya. Endpoint
baru itu mewarisi pola yang sama persis yang dikeluhkan laporan ini: baca
nilai lama di luar transaksi, lalu tulis nilai baru sebagai angka absolut
tanpa mengunci baris. Perbaikan ini diterapkan ke `adjustCustomerLoyalty`.

## 1. Sebelum perbaikan (kode hasil H-1, sebelum M-6)

```js
async function adjustCustomerLoyalty(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const reason = parseRequiredString(req.body.reason, 'reason', 500);
    // ...parsing nextTotalPoint / nextAvailablePoint / nextBalance...

    // (1) DIBACA DI LUAR TRANSAKSI -- snapshot bisa basi begitu transaksi
    //     benar-benar mulai, apalagi kalau ada request lain nyelip di antaranya.
    const beforeCustomer = await getCustomerAuditSnapshot(id);
    const currentTotalPoint = beforeCustomer.customer_point?.total_point ?? 0;
    const currentAvailablePoint = beforeCustomer.customer_point?.available_point ?? 0;

    // (2) INVARIANT DIVALIDASI TERHADAP SNAPSHOT BASI ITU
    const effectiveTotalPoint = nextTotalPoint ?? currentTotalPoint;
    const effectiveAvailablePoint = nextAvailablePoint ?? currentAvailablePoint;
    if (effectiveAvailablePoint > effectiveTotalPoint) {
      return badRequest(res, 'available_point tidak boleh melebihi total_point');
    }

    const customer = await prisma.$transaction(async (tx) => {
      // (3) DITULIS SEBAGAI NILAI ABSOLUT, TANPA MENGUNCI BARIS CustomerPoint
      await tx.customerPoint.upsert({
        where: { customer_id: id },
        update: {
          ...(hasTotalPoint && { total_point: nextTotalPoint }),
          ...(hasAvailablePoint && { available_point: nextAvailablePoint }),
        },
        create: { customer_id: id, total_point: effectiveTotalPoint, ... },
      });
      // ...
    });
    // ...
  } catch (error) { handleError(res, error); }
}
```

**Masalah (TOCTOU — time-of-check-time-of-use):**

1. Nilai `total_point`/`available_point` saat ini dibaca **sebelum**
   `prisma.$transaction` dimulai, lewat `getCustomerAuditSnapshot` biasa
   (bukan `SELECT ... FOR UPDATE`) — tidak ada penguncian baris sama sekali.
2. Invariant `available_point ≤ total_point` divalidasi terhadap snapshot
   itu — snapshot yang bisa saja sudah basi begitu benar-benar sampai ke
   statement tulis, kalau ada request lain yang menulis di antaranya.
3. `customerPoint.upsert` menulis nilai **absolut** (bukan
   increment/decrement, bukan pembaruan bersyarat "hanya kalau nilai
   sekarang masih sama seperti yang saya baca tadi").

**Skenario gagal konkret:** dua admin mengedit customer yang sama nyaris
bersamaan.
- Admin A membaca `total=1000, available=500`, mau set `available=900`
  (total tidak disentuh) → tervalidasi (900 ≤ 1000).
- Admin B membaca `total=1000, available=500` (snapshot yang **sama**,
  sebelum tulisan A masuk), mau set `total=800` (available tidak disentuh)
  → tervalidasi (500 ≤ 800, memakai available versi lama).
- Kedua tulisan sama-sama lolos validasi masing-masing dan sama-sama
  tereksekusi → hasil akhir `total=800, available=900` — **invariant yang
  tadinya "sudah divalidasi" ternyata dilanggar**, karena masing-masing
  divalidasi terhadap potongan realita yang berbeda (lost update).

## 2. Perbaikan

Baca ulang nilai terkini **di dalam** transaksi lewat
`SELECT ... FOR UPDATE`, yang mengunci baris `CustomerPoint` sampai
transaksi selesai. Request kedua yang datang bersamaan untuk customer yang
sama akan **menunggu** baris itu (bukan membaca snapshot lama), baru
kemudian membaca nilai yang **sudah memasukkan** hasil commit request
pertama — sehingga validasi invariant-nya otomatis memakai data terbaru,
bukan data basi.

```js
const { customer, currentTotalPoint, currentAvailablePoint } =
  await prisma.$transaction(async (tx) => {
    const [customerRow] = await tx.$queryRaw`
      SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE
    `;
    if (!customerRow) throw Object.assign(new Error('Customer tidak ditemukan'), { code: 'P2025' });

    let lockedTotalPoint = 0;
    let lockedAvailablePoint = 0;

    if (hasTotalPoint || hasAvailablePoint) {
      // Baris ini yang menutup race condition-nya.
      const [pointRow] = await tx.$queryRaw`
        SELECT total_point, available_point FROM "CustomerPoint"
        WHERE customer_id = ${id} FOR UPDATE
      `;
      lockedTotalPoint = pointRow?.total_point ?? 0;
      lockedAvailablePoint = pointRow?.available_point ?? 0;

      const effectiveTotalPoint = nextTotalPoint ?? lockedTotalPoint;
      const effectiveAvailablePoint = nextAvailablePoint ?? lockedAvailablePoint;

      if (effectiveAvailablePoint > effectiveTotalPoint) {
        throw Object.assign(
          new Error('available_point tidak boleh melebihi total_point'),
          { code: 'INVALID_INVARIANT' },
        );
      }

      await tx.customerPoint.upsert({ /* ...update dgn nilai baru... */ });
      // ...tulis PointHistory kalau pointsChange !== 0...
    }

    if (hasBalance) {
      await tx.customer.update({ where: { id }, data: { balance: nextBalance, ... } });
    }

    return { customer: await tx.customer.findUnique({ where: { id }, include: getAdminCustomerInclude() }), ... };
  });
```

**Kenapa tetap "set nilai absolut", bukan pindah ke increment/decrement?**
Rekomendasi laporan memberi dua opsi: *"pakai update kondisional/berversi
**atau** operasi increment/decrement"*. Endpoint ini secara desain memang
dimaksudkan untuk koreksi manual ke *nilai yang benar menurut admin*
(misalnya "yang benar seharusnya 2450 poin", bukan "tambah 50 poin") — jadi
mengubahnya jadi delta akan mengubah kontrak API dan pengalaman admin tanpa
alasan yang perlu. Race condition-nya diselesaikan lewat **opsi
pertama**: pembaruan kondisional berbasis row lock, transisi valid, dan
validasi ulang di dalam transaksi — konsisten dengan pola yang sudah
dipakai di perbaikan M-5 (`updateRedemptionStatus`) yang juga memakai
`SELECT ... FOR UPDATE` untuk masalah serupa.

## 3. Verifikasi

Diuji langsung terhadap database produksi (Supabase) memakai customer
sintetis. Dua bagian: (a) sanity check bahwa perilaku normal tidak berubah,
dan (b) **pengujian race condition sungguhan** — dua panggilan
`adjustCustomerLoyalty` untuk customer yang SAMA ditembak lewat
`Promise.all` (genuinely concurrent, dua transaksi Prisma terpisah di dua
koneksi DB berbeda), bukan disimulasikan berurutan.

```
Initial state: total=1000, available=500

=== Sanity check ===
set available_point=700 (total=1000) -> status: 200, tersimpan
set total_point=500 saat available=700 -> status: 400
  { message: 'available_point tidak boleh melebihi total_point' }   <- invariant tetap jalan normal

=== Race test: DUA PANGGILAN BERSAMAAN untuk customer yang SAMA ===
Call A: set available_point=900 (total dibiarkan, saat itu 1000)
Call B: set total_point=800     (available dibiarkan, terbaca 500 saat itu)

TANPA perbaikan: keduanya bisa membaca nilai basi, keduanya lolos validasi
masing-masing, keduanya menulis -> hasil akhir total=800, available=900
-> INVARIANT DILANGGAR (900 > 800).

DENGAN perbaikan (row lock):
Call A result: status 200 { total_point: 1000, available_point: 900 }
Call B result: status 400 'available_point tidak boleh melebihi total_point'

FINAL STATE: { total_point: 1000, available_point: 900 }
Invariant available_point <= total_point holds: true   <- TERBUKTI TERJAGA

PointHistory entries:
  { type: 'admin_adjustment', points_change: 400, description: 'race test A' }
  (Call B tidak menulis apa pun -- ditolak sebelum ada statement tulis yang jalan)
```

Call B **ditolak**, bukan karena request-nya salah secara statis (500 ≤ 800
tetap valid kalau dievaluasi sendirian), tapi karena row lock memaksanya
menunggu Call A commit lebih dulu, lalu membaca ulang `available_point`
yang sudah jadi 900 (bukan 500 yang basi) — sehingga `900 > 800` yang
benar-benar terpakai untuk validasi, persis perilaku yang diinginkan.
Ini adalah bukti langsung bahwa lost-update sudah tertutup, bukan cuma
argumen di atas kertas.

Data uji dibersihkan setelahnya dan diverifikasi nol sisa di database.

### Syntax check & module load

```
$ node --check src/controllers/adminLoyaltyController.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
module type: function LOAD OK
```

## 4. Yang TIDAK berubah

- Kontrak API `adjustCustomerLoyalty` (body, response) — tidak berubah;
  perbaikan murni di implementasi internal (locking + validasi ulang).
- `updateRedemptionStatus` (M-5) — sudah memakai pola `SELECT ... FOR
  UPDATE` yang sama sejak awal, tidak terdampak bug ini, tidak disentuh.
- `updateAdminCustomer` — sejak H-1 sudah tidak menulis poin/saldo sama
  sekali, tidak ada yang perlu diperbaiki di sana untuk M-6.
- Skema database — tidak ada migration baru; `SELECT ... FOR UPDATE`
  adalah fitur standar Postgres, tidak butuh perubahan skema.

## 5. Batasan yang diketahui (didokumentasikan, bukan dianggap tidak ada)

Ada satu celah race yang sangat sempit dan sengaja tidak ditangani lebih
jauh: kalau baris `CustomerPoint` untuk seorang customer **belum pernah
ada sama sekali**, `SELECT ... FOR UPDATE` terhadap baris yang belum ada
tidak mengunci apa pun (tidak ada baris untuk dikunci). Dua adjustment
PERTAMA yang benar-benar terjadi di milidetik yang sama untuk customer yang
sama secara teori bisa sama-sama lolos ke jalur `create`. Ini dijamin aman
di level database berkat constraint `@unique` pada `CustomerPoint.customer_id`
(Prisma mengompilasi `upsert` jadi `INSERT ... ON CONFLICT DO UPDATE`
atomik), sehingga tidak akan menghasilkan dua baris ganda atau error — hanya
saja validasi invariant untuk skenario yang sangat spesifik ini (adjustment
pertama sekaligus untuk customer yang sama) berpotensi memakai asumsi
"belum ada data" untuk keduanya. Begitu baris pertama ada, seluruh
adjustment berikutnya (termasuk balapan berikutnya) tertutup penuh oleh
perbaikan di atas. Risiko ini dinilai dapat diterima mengingat sifatnya
admin-only, volume rendah, dan hanya berlaku untuk adjustment paling
pertama seumur hidup seorang customer.
