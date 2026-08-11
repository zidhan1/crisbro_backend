# M-5 (MEDIUM) — updateRedemptionStatus tanpa state machine dan tidak menyesuaikan poin

Status: **Fixed**
File terdampak: `src/controllers/adminLoyaltyController.js` (`updateRedemptionStatus`)

## 1. Sebelum perbaikan

```js
async function updateRedemptionStatus(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const status = parseRequiredString(req.body.status, 'status', 30);
    const allowed = new Set(['pending', 'claimed', 'expired']);

    if (!allowed.has(status)) {
      return badRequest(res, 'status tidak valid');
    }

    const redemption = await prisma.rewardRedemption.update({
      where: { id },
      data: {
        status,
        redeemed_at: status === 'claimed' ? new Date() : null,
      },
      include: { reward: ..., customer: ... },
    });

    res.json(redemption);
  } catch (error) {
    handleError(res, error);
  }
}
```

**Masalah:**

1. **Tidak ada state machine.** `status` cuma divalidasi "termasuk salah
   satu dari 3 nilai yang diizinkan", bukan divalidasi transisinya. Semua
   transisi diperbolehkan, termasuk `claimed → pending` (menghapus
   `redeemed_at` begitu saja, tanpa alasan bisnis) dan `expired → claimed`
   (menghidupkan lagi redemption yang sudah kedaluwarsa).
2. **Tidak ada penyesuaian poin sama sekali.** Tidak ada baris kode yang
   menyentuh `CustomerPoint` atau `PointHistory`. Kalau redemption
   dimaksudkan memotong poin saat diklaim, poin itu tidak pernah benar-benar
   terpotong; dan tidak ada mekanisme mengembalikan poin kalau
   klaim dibatalkan/reward tidak jadi diambil.
3. Tidak ada jejak audit (`recordAdminActivity` tidak dipanggil sama
   sekali di endpoint ini, berbeda dengan endpoint admin lain di file yang
   sama).

**Skenario gagal konkret:** admin set redemption jadi `claimed` (idealnya
memotong 150 poin), lalu tidak sengaja ubah jadi `pending` (poin yang
sudah terpotong tidak pernah dikembalikan, `redeemed_at` hilang), lalu
ubah lagi jadi `claimed` (berpotensi memotong poin **kedua kalinya**).
Saldo poin customer dan status redemption jadi dua sumber kebenaran yang
saling bertentangan.

## 2. Desain perbaikan

### 2.1 State machine transisi valid

```js
const REDEMPTION_STATUS_TRANSITIONS = {
  pending: ['claimed', 'expired'],
  claimed: ['expired'],
  expired: [],
};
```

| Transisi | Diizinkan? | Alasan |
|---|---|---|
| `pending → claimed` | Ya | Klaim normal — di sinilah poin dipotong |
| `pending → expired` | Ya | Reward tidak pernah diambil sebelum tenggat |
| `claimed → expired` | Ya | Jalur "void"/pembatalan klaim — di sinilah poin dikembalikan |
| `claimed → pending` | **Tidak** | Skenario persis yang disebut di laporan; tidak ada alasan bisnis untuk mundur ke pending setelah diklaim |
| `expired → apa pun` | **Tidak** | `expired` bersifat terminal |
| `X → X` (status sama) | **Tidak** | Ditolak eksplisit (`"Redemption sudah berstatus X"`) supaya tidak ada logika poin yang jalan dua kali secara tidak sengaja |

`redeemed_at` **tidak pernah** ditimpa jadi `null` lagi. Begitu sebuah
redemption pernah diklaim, waktu klaimnya tetap tercatat walau belakangan
di-void ke `expired` — konsisten dengan prinsip "jangan hapus riwayat" yang
sudah dipakai di audit log lainnya di file ini.

### 2.2 Penyesuaian `CustomerPoint` atomik, terikat ke transisi

| Transisi | Efek ke poin |
|---|---|
| `pending → claimed` | **Debit** `points_spent` dari `available_point`. Divalidasi lebih dulu (`available_point >= points_spent`); kalau tidak cukup, ditolak 400 sebelum ada satu pun statement DB yang jalan. |
| `claimed → expired` | **Refund** `points_spent` kembali ke `available_point` — aman karena kita tahu pasti poin itu pernah dipotong oleh transisi `pending → claimed` yang sama-sama lewat fungsi ini. |
| `pending → expired` | Tidak ada penyesuaian — reward memang belum pernah diklaim, jadi poin memang belum pernah dipotong. |

Setiap debit/refund menulis satu baris `PointHistory`
(`type: 'redeem'` untuk debit, `type: 'redeem_refund'` untuk refund,
`reward_redemption_id` terisi) — ledger yang sama yang mulai dipakai di
perbaikan H-1 (`adjustCustomerLoyalty`), sekarang juga dipakai di jalur
redemption.

Seluruh urutan (baca status terkini, validasi transisi, cek saldo,
update poin, tulis `PointHistory`, update `RewardRedemption`) dibungkus
**satu** `prisma.$transaction()` — kalau ada satu langkah yang gagal,
semuanya batal bersama, tidak ada kondisi "status berubah tapi poin lupa
disesuaikan" atau sebaliknya.

### 2.3 Row lock untuk mencegah race condition

Baris `RewardRedemption` dibaca lewat
`SELECT * FROM "RewardRedemption" WHERE id = ${id} FOR UPDATE` di dalam
transaksi, bukan `findUnique` biasa. Ini mengunci baris tersebut sampai
transaksi selesai, sehingga dua request klaim yang datang nyaris
bersamaan untuk redemption yang sama tidak bisa sama-sama lolos
pengecekan "status masih pending" dan berujung memotong poin dua kali.

### 2.4 Audit log ditambahkan

`recordAdminActivity` sekarang dipanggil untuk setiap transisi yang
berhasil (action `update_redemption_status`), sesuatu yang sebelumnya
tidak ada sama sekali di endpoint ini — konsisten dengan endpoint admin
lain di file yang sama.

### 2.5 Error handling

Error validasi (transisi tidak valid, poin tidak cukup) ditandai dengan
`error.code` khusus (`INVALID_TRANSITION`, `INSUFFICIENT_POINTS`) dan
ditangkap eksplisit sebagai `400 Bad Request` sebelum jatuh ke
`handleError` generik — bukan mengandalkan pencocokan substring pesan
seperti pola lama, supaya tidak salah terklasifikasi sebagai `500`.

## 3. Verifikasi

Diuji langsung terhadap database produksi (Supabase) memakai customer,
reward, dan redemption sintetis (dibuat & dibersihkan eksplisit, nol sisa
diverifikasi setelahnya), lewat pemanggilan langsung fungsi
`updateRedemptionStatus` dengan `req`/`res` tiruan — bukan cuma baca kode.

```
=== Case 1: pending -> claimed (valid, seharusnya memotong 150 poin) ===
status: 200 | redemption.status: claimed | redeemed_at set: true
available_point setelah klaim (harus 50, dari 200): 50

=== Case 2: claimed -> pending (harus DITOLAK) ===
status: 400 { message: 'Transisi status claimed -> pending tidak diizinkan' }
available_point tidak berubah (harus tetap 50): 50

=== Case 3: claimed -> expired (void yang sah, harus refund 150) ===
status: 200 | redemption.status: expired | redeemed_at tetap ada: 2026-08-06T09:37:14.175Z
available_point setelah refund (harus kembali 200): 200

=== Case 4: expired -> claimed (terminal, harus DITOLAK) ===
status: 400 { message: 'Transisi status expired -> claimed tidak diizinkan' }

=== Case 5: pending -> expired (tidak pernah diklaim, tanpa perubahan poin) ===
status: 200 | redemption.status: expired | redeemed_at: null
available_point tidak berubah (harus tetap 200): 200

=== Case 6: poin tidak cukup (tersedia 200, dibutuhkan 9999) ===
status: 400 { message: 'Poin customer tidak cukup untuk klaim (tersedia 200, dibutuhkan 9999)' }
available_point tidak berubah (harus tetap 200): 200

=== PointHistory ledger (harus -150 redeem, lalu +150 redeem_refund) ===
[
  { type: 'redeem',        points_change: -150, reward_redemption_id: 1 },
  { type: 'redeem_refund', points_change:  150, reward_redemption_id: 1 }
]

=== AdminActivityLog entries (hanya transisi yang BERHASIL yang tercatat) ===
[
  { entity_id: 1, metadata: { new_status: 'claimed' } },
  { entity_id: 1, metadata: { new_status: 'expired' } },
  { entity_id: 2, metadata: { new_status: 'expired' } }
]
```

Semua 6 skenario (klaim normal, transisi mundur yang harus ditolak, void
dengan refund, transisi dari status terminal, expire tanpa pernah diklaim,
dan saldo tidak cukup) menghasilkan perilaku yang benar. `PointHistory`
menunjukkan ledger yang seimbang (-150 lalu +150 untuk redemption yang
sama), dan `AdminActivityLog` hanya mencatat transisi yang benar-benar
terjadi (2 percobaan yang ditolak tidak meninggalkan entri, karena
`recordAdminActivity` baru dipanggil setelah transaksi berhasil commit).

Setelah pengujian, seluruh data sintetis dibersihkan dan diverifikasi nol
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
 src/controllers/adminLoyaltyController.js | 163 +++++++++++++++++++++++++++---
 1 file changed, 150 insertions(+), 13 deletions(-)
```

## 4. Catatan desain: mengapa debit di `claimed`, bukan di `pending`

Tidak ada kode di repo ini yang membuat baris `RewardRedemption`
(`grep -rn "rewardRedemption.create"` tidak menemukan apa pun) — jalur
redeem lokal untuk customer sudah dinonaktifkan sejak migrasi ke POS
Runchise (`redemptionController.js` sengaja mengembalikan `410 Gone`).
Karena itu, tidak ada bukti di kode bahwa poin sudah dipotong saat baris
`pending` dibuat.

Desain yang dipilih (debit saat `pending → claimed`, bukan saat baris
dibuat) sengaja diambil karena lebih aman terhadap ketidaktahuan ini:
kalau asumsinya salah — misalnya nanti ternyata poin memang sudah dipotong
di tempat lain saat baris `pending` dibuat — dampaknya "hanya" poin
terpotong dua kali (bug yang terlihat jelas dan gampang diaudit lewat
`PointHistory`). Desain sebaliknya (asumsi poin sudah dipotong saat
`pending`, lalu me-refund saat `expired`) jauh lebih berbahaya kalau
asumsinya salah: customer bisa membuat banyak redemption `pending`
bernilai tinggi, membiarkannya `expired`, dan mendapat poin gratis yang
tidak pernah benar-benar mereka miliki.

## 5. Yang TIDAK berubah

- `listRedemptions` — tidak disentuh.
- Skema database — tidak ada migration baru; `PointHistory.type` sudah
  berupa kolom `TEXT` bebas tanpa CHECK constraint (sama seperti yang
  dikonfirmasi saat perbaikan H-1), sehingga nilai baru `'redeem_refund'`
  aman ditambahkan tanpa migration.
- `total_point` tidak pernah disentuh oleh perbaikan ini — hanya
  `available_point` yang didebit/direfund, konsisten dengan
  `total_point` sebagai angka historis kumulatif (bukan saldo yang
  berkurang saat redeem), pola yang sama dengan `adjustCustomerLoyalty`
  di H-1.

## Update — celah residual ditutup: saldo poin bisa minus saat klaim

### 1. Celah yang tersisa

Perbaikan awal (state machine + debit/refund atomik) sudah benar, tetapi
menyisakan satu lubang: di dalam transaksi klaim, yang dikunci hanya baris
`RewardRedemption`:

```js
const [current] = await tx.$queryRaw`
  SELECT * FROM "RewardRedemption" WHERE id = ${id} FOR UPDATE
`;
...
const point = await tx.customerPoint.findUnique({   // <-- TIDAK terkunci
  where: { customer_id: customerId },
});
if (point.available_point < pointsSpent) throw ...  // cek di atas data basi
await tx.customerPoint.update({ data: { available_point: { decrement: ... } } });
```

Mengunci `RewardRedemption` hanya mencegah **redemption yang sama** diklaim
dua kali. Baris yang sebenarnya jadi rebutan saat klaim adalah
`CustomerPoint`. Dua klaim untuk redemption **berbeda** milik customer
**yang sama** mengunci baris `RewardRedemption` berbeda, sehingga di
isolation level default PostgreSQL (`READ COMMITTED`, tidak ada override di
kode) keduanya berjalan berbarengan:

```text
Customer punya 100 poin, dua redemption pending @60 poin

t1  A: kunci RewardRedemption #1
t2  B: kunci RewardRedemption #2      <- baris beda, tidak menunggu
t3  A: baca saldo -> 100
t4  B: baca saldo -> 100              <- masih 100
t5  A: cek 100 >= 60 -> LOLOS
t6  B: cek 100 >= 60 -> LOLOS
t7  A: decrement 60 -> 40
t8  A: COMMIT
t9  B: decrement 60 -> -20
t10 B: COMMIT                         -> available_point = -20
```

Catatan penting: ini **bukan** lost update. `decrement` menghasilkan
`SET available_point = available_point - 60`, dan UPDATE kedua menunggu lock
baris lalu membaca ulang nilai terbaru — jadi kedua pengurangan tetap masuk.
Yang bocor adalah **cek kecukupannya**, karena dievaluasi di atas saldo basi.

### 2. Kenapa lapisan pengaman lain tidak menangkapnya

- Invariant `available_point <= total_point` (H-1/M-6) tetap terpenuhi:
  `-20 <= 100`. Lagi pula invariant itu berada di `adjustCustomerLoyalty`,
  fungsi yang berbeda.
- Tidak ada `CHECK` constraint di database — kolomnya hanya
  `available_point Int @default(0)`, sehingga PostgreSQL menerima nilai
  negatif tanpa protes.
- Tidak ada error yang dilempar; kedua request membalas sukses.

### 3. Perbaikan

Saldo kini dibaca dengan kunci baris, dan nilai hasil kunci itulah yang
dipakai untuk memutuskan:

```js
const [lockedPoint] = await tx.$queryRaw`
  SELECT available_point FROM "CustomerPoint"
  WHERE customer_id = ${customerId} FOR UPDATE
`;
const availablePoint = lockedPoint?.available_point ?? 0;
```

Transaksi kedua kini menunggu di baris `CustomerPoint` sampai transaksi
pertama commit, lalu membaca saldo terbaru (40) dan cek kecukupannya gagal
dengan benar (`40 < 60`) — bukan lolos lalu membuat minus.

**Urutan kunci** yang berlaku di seluruh backend:

| Jalur | Urutan |
|---|---|
| `updateRedemptionStatus` (klaim) | RewardRedemption → CustomerPoint |
| `adjustCustomerLoyalty` | Customer → CustomerPoint |
| `deleteAdminCustomer` | RewardRedemption → CustomerPoint |

Tidak ada dua jalur yang mengambil kunci dengan urutan berlawanan, jadi tidak
ada potensi deadlock. Aturannya didokumentasikan langsung di komentar kode:
jalur baru yang mengubah saldo wajib mengunci `CustomerPoint` paling akhir.

Jalur refund (`claimed -> expired`) sengaja **tidak** diubah: operasinya
`increment`, yang tidak bisa membuat saldo minus dan tidak punya cek
pra-syarat yang bisa basi.

Ditelusuri juga bahwa `decrement` pada `available_point` hanya ada di **satu**
tempat di seluruh backend (jalur klaim ini). Jalur lain yang menyebut
`available_point` — `authController`, `customerController`,
`summaryController` — semuanya hanya membaca. Jadi perbaikan ini menutup
seluruh permukaan, bukan sebagian.

### 4. Pengujian terukur

`test/redemptionStatusTransition.test.js` naik dari 7 ke **13 test**, seluruhnya
lulus. Enam test baru mengunci mekanismenya:

- saldo dibaca dengan `FOR UPDATE` dan menyasar `customer_id` yang benar
  (bukan seluruh tabel);
- urutan kunci `RewardRedemption` → `CustomerPoint` terjaga;
- `customerPoint.findUnique` yang tidak mengunci **tidak dipanggil lagi** di
  jalur klaim;
- saldo persis pas (`available === points_spent`) tetap diizinkan;
- kurang satu poin ditolak dan tidak ada satu pun statement tulis yang jalan;
- customer tanpa baris `CustomerPoint` diperlakukan sebagai saldo 0, bukan
  lolos diam-diam.

Mock `$queryRaw` pada file test dibuat sadar-SQL, karena jalur klaim kini
melakukan dua pembacaan terkunci yang berbeda; mock lama mengembalikan baris
redemption untuk query apa pun sehingga tidak bisa membedakan keduanya.

Diverifikasi **tidak vacuous** lewat mutation check: mengembalikan kode ke
`findUnique` tanpa kunci membuat tepat 3 test M-5 gagal, lalu kode
dikembalikan.

Seluruh suite backend: **83/83 lulus**.

### 5. Batas pengujian ini — dibaca dengan jujur

Race sungguhan hanya bisa dibuktikan dengan dua koneksi PostgreSQL nyata yang
berjalan bersamaan, dan suite ini sengaja tidak menyentuh database. Yang
dikunci test di atas adalah **mekanisme** yang membuat race itu mustahil
(kunci baris diambil sebelum cek, dan nilai hasil kunci yang dipakai), bukan
race-nya sendiri. Jaminan bahwa `SELECT ... FOR UPDATE` benar-benar
menyerialkan transaksi datang dari PostgreSQL, bukan dari test ini.

### 6. Tindak lanjut yang disarankan (belum dikerjakan)

Tambahkan `CHECK (available_point >= 0)` sebagai lapis pertahanan terakhir,
supaya kalaupun ada jalur baru yang lupa mengunci, database yang menolak
alih-alih diam-diam menerima. Sebaiknya dibuat `NOT VALID` lebih dulu:

```sql
ALTER TABLE "CustomerPoint"
  ADD CONSTRAINT "CustomerPoint_available_point_non_negative"
  CHECK ("available_point" >= 0) NOT VALID;
```

`NOT VALID` membuat constraint berlaku untuk semua penulisan baru tanpa
memvalidasi baris lama — penting karena bila sudah ada saldo negatif akibat
bug ini, migration biasa akan gagal saat deploy. Setelah data lama
dibersihkan, jalankan `VALIDATE CONSTRAINT`.

Sengaja belum dikerjakan karena Prisma tidak merepresentasikan `CHECK`
constraint di `schema.prisma`, sehingga berpotensi memunculkan drift pada
`prisma migrate` berikutnya — keputusan itu sebaiknya diambil sadar, bukan
menyelinap di dalam perbaikan ini.
