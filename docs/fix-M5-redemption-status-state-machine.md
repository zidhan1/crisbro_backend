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
