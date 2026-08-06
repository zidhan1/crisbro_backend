# M-4 (MEDIUM) — Parsing tanggal promo/POS memakai waktu lokal server (UTC), bukan WIB

Status: **Fixed**
File terdampak: `src/services/syncService.js` (`parseRunchiseDate`, `addDays`, `getEffectivePromoStatus` via `mapRunchisePromoToLocalData`)

## 1. Masalah

`parseRunchiseDate(value, endOfDay)` mengubah tanggal Runchise (format
`DD/MM/YYYY`, selalu dalam WIB/UTC+7) menjadi objek `Date` lewat:

```js
return endOfDay
  ? new Date(year, month - 1, day, 23, 59, 59, 999)
  : new Date(year, month - 1, day, 0, 0, 0, 0);
```

Konstruktor `new Date(year, month, day, ...)` membangun tanggal di **zona
waktu runtime proses Node**, bukan WIB. Di lokal (kebetulan WIB) itu terlihat
benar; di Vercel (UTC) hasilnya meleset **7 jam penuh** — tanggal yang
seharusnya berarti "06/08/2026 00:00 WIB" malah dibaca sebagai
"06/08/2026 00:00 UTC" (= 07:00 WIB).

`getEffectivePromoStatus()` memakai hasil parsing ini untuk menentukan
status `active`/`inactive`/`completed` dengan membandingkan `now` terhadap
`start`/`end`. Akibatnya, di jendela ±7 jam sekitar tengah malam WIB, status
promo bisa salah: promo yang seharusnya sudah `active` sejak 00:00 WIB masih
terbaca `inactive` sampai jam 07:00 WIB, dan promo yang seharusnya
`completed` sejak 00:00 WIB baru terbaca demikian setelah jam 07:00 WIB.

Kode lain di repo yang menangani tanggal Runchise serupa
(`runchisePosRewardRedemptionService.js`) sudah menyematkan offset
`+07:00` secara eksplisit dan **tidak** kena bug ini — jadi pola perbaikan
yang benar sudah ada duluan di codebase, tinggal diterapkan konsisten di
`syncService.js`.

## 2. Bukti bug (dijalankan sebelum perbaikan, runtime disimulasikan UTC seperti Vercel)

```
$ TZ=UTC node -e "... parseRunchiseDate versi LAMA ..."

start 06/08/2026 -> 2026-08-06T00:00:00.000Z   <- SALAH, harusnya 2026-08-05T17:00:00.000Z
end   06/08/2026 -> 2026-08-06T23:59:59.999Z   <- SALAH, harusnya 2026-08-06T16:59:59.999Z

Drift: 7 jam
```

Kasus konkret yang menunjukkan status ter-flip salah (promo mulai
`06/08/2026`, dicek jam 03:00 WIB tanggal 6 -- secara WIB promo SUDAH mulai):

```
now (WIB 03:00 dini hari, tanggal 6): 2026-08-05T20:00:00.000Z
start_date (versi lama, salah baca sebagai UTC): 2026-08-06T00:00:00.000Z
status (BUG LAMA): inactive   <- SALAH, harusnya active
```

## 3. Perbaikan

### 3.1 `parseRunchiseDate` — offset `+07:00` eksplisit

Diubah untuk membangun string ISO 8601 dengan offset WIB eksplisit, lalu
diserahkan ke `new Date(...)` yang menghormati offset dalam string tersebut
terlepas dari zona waktu runtime:

```js
function parseRunchiseDate(value, endOfDay = false) {
  if (!value) return null;

  const parts = String(value).split('/');
  if (parts.length !== 3) return null;

  const [day, month, year] = parts.map(Number);
  if (!day || !month || !year) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const timeOfDay = endOfDay ? '23:59:59.999' : '00:00:00.000';
  const date = new Date(`${year}-${pad(month)}-${pad(day)}T${timeOfDay}+07:00`);

  return Number.isNaN(date.getTime()) ? null : date;
}
```

Pola ini identik dengan yang sudah dipakai di
`runchisePosRewardRedemptionService.js`
(`new Date(\`${startDate}T00:00:00+07:00\`)`), sekarang diterapkan konsisten
di jalur promo juga.

### 3.2 `addDays` — dibuat eksplisit UTC-safe

```js
function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
```

`setDate`/`getDate` versi lokal (tanpa `UTC`) sebenarnya masih benar secara
matematis di runtime UTC (karena baik WIB maupun UTC tidak mengenal DST,
jadi pergeseran hari tetap mempertahankan jam-menit-detik yang sama).
Tetap diganti ke `setUTCDate`/`getUTCDate` supaya kebenarannya **tidak lagi
bergantung pada asumsi zona waktu runtime** — konsisten dengan semangat
perbaikan M-4 (jangan pernah mengandalkan zona waktu lokal proses untuk
data yang maknanya WIB).

### 3.3 `getEffectivePromoStatus` — tidak diubah, otomatis ikut benar

Fungsi ini hanya membandingkan `Date.getTime()` (instant UTC absolut) yang
sudah benar berkat perbaikan di 3.1 — tidak ada logika di dalamnya yang
bergantung pada zona waktu runtime, jadi tidak perlu perubahan langsung.

## 4. Verifikasi

Dijalankan dengan `TZ=UTC` (mensimulasikan runtime Vercel) lewat fungsi
`mapRunchisePromoToLocalData` yang **sungguhan diekspor** dari
`syncService.js` (bukan simulasi terpisah), memanggil `parseRunchiseDate`
dan `getEffectivePromoStatus` yang sudah diperbaiki:

```
$ TZ=UTC node -e "... mapRunchisePromoToLocalData(promo, context, now) ..."

Simulated runtime TZ: UTC

now (WIB 10:00 pagi):
  2026-08-06T03:00:00.000Z
start_at: 2026-08-05T17:00:00.000Z (harus 2026-08-05T17:00:00.000Z = tengah malam WIB)  -> COCOK
status: active (harus active, karena jam 10 pagi WIB masih dalam rentang 06/08 00:00-23:59:59 WIB)  -> COCOK

now (WIB 03:00 dini hari, tanggal 6):
  2026-08-05T20:00:00.000Z
status: active (harus active -- sudah lewat 00:00 WIB tgl 6 sesuai start_date)  -> COCOK
  (kasus ini SEBELUMNYA salah jadi 'inactive' -- lihat bagian 2)

now (WIB 23:00, tanggal 5, SEBELUM start_date):
  2026-08-05T16:00:00.000Z
status: inactive (harus inactive -- belum lewat 00:00 WIB tgl 6)  -> COCOK
```

Ketiga kasus tepat di titik paling rawan (dini hari WIB, tepat sebelum
tengah malam WIB) sekarang menghasilkan status yang benar, diverifikasi
lewat runtime yang disimulasikan sama seperti production (UTC).

### Syntax check & module load

```
$ node --check src/services/syncService.js && echo "SYNTAX OK"
SYNTAX OK

$ node -e "require('./src/index.js'); console.log('LOAD OK')"
module type: function LOAD OK
```

### Diff summary

```
 src/services/syncService.js | 26 ++++++++++++++++++++++----
 1 file changed, 22 insertions(+), 4 deletions(-)
```

## 5. Yang TIDAK berubah

- `getEffectivePromoStatus` — logikanya sudah benar sejak awal; hanya
  input (`start`/`end`) yang sebelumnya salah.
- Format `start_date`/`end_date` yang disimpan ke tabel `Promo`
  (`promo.start_date`/`promo.end_date`, string mentah dari Runchise) —
  tidak diubah; hanya `start_at` (kolom `DateTime` turunan yang dipakai
  untuk perbandingan waktu) dan status yang terpengaruh perbaikan ini.
- `runchisePosRewardRedemptionService.js` — sudah benar sebelumnya, tidak
  disentuh; dipakai di sini sebagai referensi pola yang benar.
- Tidak ada migration database — perubahan murni logika parsing tanggal di
  memori, tidak ada perubahan skema.

## 6. Dampak

Sebelum perbaikan ini, di runtime UTC (Vercel), promo yang batas
mulai/akhirnya jatuh dalam jendela pukul 00:00–07:00 WIB berisiko:

- Belum dianggap `active` walau sudah lewat tanggal mulai (WIB) — customer
  tidak melihat promo yang seharusnya sudah berlaku.
- Masih dianggap `active` walau sudah lewat tanggal berakhir (WIB) selama
  hingga 7 jam — promo yang sudah berakhir masih tampak berlaku.

Setelah perbaikan, batas waktu promo konsisten dengan WIB terlepas dari
zona waktu tempat function Vercel dijalankan.
