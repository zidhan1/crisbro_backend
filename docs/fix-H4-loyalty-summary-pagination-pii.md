# H-4 (HIGH) — `getSummary` memuat seluruh redemption dan membocorkan PII massal

Status: **Fixed**

File terdampak:

- Backend: `src/controllers/adminLoyaltyController.js`
- Backend: `src/lib/loyaltySummaryProjection.js`
- Backend: `test/loyaltySummaryProjection.test.js`
- Frontend: `crisbro-frontend/src/lib/admin.ts`

Route terdampak: `GET /api/admin/loyalty-summary`

Kategori: **Performa, Privasi/PII, DoS**

## 1. Masalah

Sebelum perbaikan, `getSummary` menjalankan `findMany` terhadap
`RunchisePosRewardRedemption` tanpa `take`, `skip`, atau pagination:

```js
prisma.runchisePosRewardRedemption.findMany({
  where: posRedemptionWhere,
  include: {
    redeem_menu_item: {
      select: {
        id: true,
        menu_item: { select: { id: true, name: true } },
      },
    },
  },
  orderBy: { redeemed_at: 'desc' },
});
```

Seluruh baris hasil query dimuat ke memori Node.js setiap dashboard meminta
ringkasan. Data yang sama kemudian diiterasi di application layer untuk
membangun tren harian:

```js
for (const redemption of redemptionHistory) {
  const date = redemption.redeemed_at.toISOString().slice(0, 10);
  // Agregasi count dan points_spent di memori...
}
```

Masalah ini terus membesar seiring bertambahnya transaksi. Walaupun pengguna
hanya memerlukan ringkasan dan grafik harian, endpoint membaca seluruh histori
detail dari database, memindahkannya melalui jaringan database, menahannya di
heap Node.js, mengiterasinya, lalu mengirim seluruh histori kembali ke browser.

## 2. Kebocoran PII

Response lama juga memasukkan data customer untuk setiap redemption:

```js
{
  customer_id: redemption.customer_id,
  runchise_customer_id: redemption.runchise_customer_id,
  customer_name: redemption.customer_name,
  customer_phone_number: redemption.customer_phone_number,
}
```

Route dapat diakses oleh role `admin` dan `marketing`:

```js
router.get('/loyalty-summary', adminOrMarketing, getSummary);
```

Frontend dashboard tidak menampilkan nama maupun nomor telepon pada tabel
riwayat reward. Field tersebut dikirim tanpa kebutuhan tampilan atau proses
bisnis pada summary, sehingga bertentangan dengan prinsip data minimization.

Satu request marketing dapat menerima nama dan nomor telepon seluruh customer
yang memiliki redemption dalam rentang filter. Jika filter tanggal tidak
diberikan, paparan mencakup seluruh histori yang tersimpan.

## 3. Dampak

### 3.1 Performa dan potensi DoS

- Waktu query dan transfer database bertambah secara linear mengikuti jumlah
  redemption.
- Penggunaan heap Node.js bertambah karena seluruh model Prisma beserta relasi
  dimuat sekaligus.
- Proses melakukan agregasi ulang di JavaScript untuk pekerjaan yang lebih
  efisien dilakukan database.
- Serialisasi JSON dan ukuran response bertambah tanpa batas.
- Beberapa request dashboard bersamaan dapat memperbesar tekanan memori dan CPU
  hingga menyebabkan timeout, garbage collection berat, atau process crash.

### 3.2 Privasi

- Seluruh nama dan nomor telepon customer dapat diterima role marketing.
- PII ikut masuk ke browser, DevTools, log proxy, cache, atau monitoring response
  walaupun tidak pernah ditampilkan UI.
- Radius dampak akun marketing yang disalahgunakan menjadi seluruh basis data
  redemption, bukan hanya data yang diperlukan dashboard.

### 3.3 Correctness filter outlet

Terdapat edge case tambahan: `outlet_id` yang berupa integer positif tetapi
tidak ditemukan menghasilkan `selectedOutlet = null`. Kondisi lama kemudian
tidak menambahkan filter `location_id`, sehingga request yang seharusnya menuju
satu outlet justru mengembalikan data seluruh outlet.

## 4. Kondisi sebelum perbaikan

### 4.1 Alur query lama

```text
GET /api/admin/loyalty-summary
              │
              ▼
findMany tanpa take/skip
              │
              ▼
Seluruh redemption + relasi dimuat ke Node.js
              │
              ├──► Loop JavaScript untuk tren harian
              │
              └──► Map seluruh detail + PII ke response
                            │
                            ▼
                  Response tumbuh tanpa batas
```

### 4.2 Contoh response lama

```json
{
  "redemption_trend": [
    {
      "date": "2026-08-01",
      "redemption_count": 15,
      "points_spent": 3000
    }
  ],
  "redemption_history": [
    {
      "id": "12345",
      "reward_id": 7,
      "reward_name": "Ayam Crispy",
      "customer_id": 901,
      "runchise_customer_id": 88001,
      "customer_name": "Nama Pelanggan",
      "customer_phone_number": "081234567890",
      "points_spent": 200,
      "outlet_name": "Crisbar Outlet A",
      "redeemed_at": "2026-08-01T10:30:00.000Z"
    }
  ]
}
```

Jumlah elemen `redemption_history` tidak memiliki batas.

## 5. Perbaikan

### 5.1 Tren dihitung dengan agregasi SQL `DATE_TRUNC`

Tren harian tidak lagi dibangun dari seluruh record di memori. PostgreSQL
mengagregasi langsung berdasarkan tanggal:

```sql
SELECT
  DATE_TRUNC('day', redemption."redeemed_at") AS date,
  COALESCE(SUM(redemption."quantity"), 0)::double precision
    AS redemption_count,
  COALESCE(SUM(redemption."points_spent"), 0)::double precision
    AS points_spent
FROM "RunchisePosRewardRedemption" redemption
WHERE redemption."status" = 'valid'
  AND redemption."is_managed_reward" = TRUE
GROUP BY DATE_TRUNC('day', redemption."redeemed_at")
ORDER BY DATE_TRUNC('day', redemption."redeemed_at") ASC;
```

Filter tanggal dan outlet ditambahkan menggunakan `Prisma.sql` parameterized,
bukan concatenation string. Ini mempertahankan perlindungan terhadap SQL
injection:

```js
${redemptionFrom
  ? Prisma.sql`AND redemption."redeemed_at" >= ${redemptionFrom}`
  : Prisma.empty}
```

Database hanya mengembalikan satu baris per hari, bukan satu baris per
redemption. Hasil angka SQL dinormalisasi menjadi JavaScript `number` sebelum
masuk JSON response.

### 5.2 Riwayat dibatasi dan dipaginasi

Query detail sekarang selalu memakai `skip` dan `take`:

```js
prisma.runchisePosRewardRedemption.findMany({
  where: posRedemptionWhere,
  select: { /* hanya field non-PII yang diperlukan UI */ },
  orderBy: { redeemed_at: 'desc' },
  skip: (redemptionHistoryPage - 1) * redemptionHistoryLimit,
  take: redemptionHistoryLimit,
});
```

Parameter yang tersedia:

| Parameter | Default | Batas | Keterangan |
|---|---:|---:|---|
| `redemption_history_page` | `1` | Integer positif | Halaman riwayat yang diminta |
| `redemption_history_limit` | `25` | Maksimum `100` | Jumlah record detail per halaman |

Nilai nol, negatif, pecahan, atau bukan angka ditolak oleh
`parsePositiveInt`. Limit di atas 100 dikunci menjadi 100 untuk mencegah klien
mengembalikan query ke kondisi tanpa batas.

### 5.3 Query memakai whitelist field non-PII

Query history tidak lagi menggunakan `include` model lengkap. Hanya field yang
dibutuhkan tabel dashboard yang dipilih:

```js
select: {
  id: true,
  redeem_menu_item_id: true,
  runchise_product_id: true,
  product_name: true,
  quantity: true,
  point_per_item: true,
  points_spent: true,
  selling_price: true,
  location_id: true,
  location_name: true,
  redeemed_at: true,
}
```

Field berikut tidak dibaca untuk query summary dan tidak dikirim ke response:

- `customer_id`
- `runchise_customer_id`
- `customer_name`
- `customer_phone_number`
- `raw`

Penggunaan `select` menjadi perlindungan berlapis: PII tidak hanya dihapus saat
mapping response, tetapi tidak pernah diambil dari database untuk bagian
history summary.

### 5.4 Proyeksi response menggunakan whitelist teruji

Mapping response dipisahkan ke
`src/lib/loyaltySummaryProjection.js` melalui fungsi
`toPublicRedemptionHistory()`. Fungsi membentuk objek baru hanya dari field
yang diizinkan. Jika object input secara tidak sengaja membawa PII, properti
tersebut tetap tidak diteruskan.

Dengan demikian terdapat dua lapisan data minimization:

```text
Prisma select tidak membaca PII
              │
              ▼
Projection whitelist tidak meneruskan PII
              │
              ▼
Response summary non-PII
```

### 5.5 Metadata pagination ditambahkan

Response sekarang menyertakan:

```json
{
  "redemption_history_pagination": {
    "page": 1,
    "limit": 25,
    "total": 1250,
    "total_pages": 50
  }
}
```

Nilai `total` memakai count yang sudah dibutuhkan summary sebagai
`redemption_count`, sehingga tidak menambahkan query count duplikat.

### 5.6 Filter outlet invalid menjadi fail-fast

Jika `outlet_id` diberikan tetapi location tidak ditemukan atau bukan outlet
Runchise, request sekarang dihentikan:

```text
outlet_id tidak ditemukan atau bukan outlet Runchise
```

Request tersebut tidak lagi jatuh ke kondisi tanpa filter yang dapat
mengembalikan data seluruh outlet.

## 6. Alur setelah perbaikan

```text
GET /api/admin/loyalty-summary
              │
              ├── Validasi tanggal, outlet, page, limit
              │
              ├── SQL DATE_TRUNC + SUM
              │       └── satu baris agregat per hari
              │
              ├── findMany select non-PII
              │       └── maksimal 25 default / 100 hard limit
              │
              ├── Projection whitelist
              │
              └── Response ringkas + metadata pagination
```

Ukuran detail response kini dibatasi secara konstan oleh limit, sementara tren
bertumbuh berdasarkan jumlah hari, bukan jumlah transaksi.

## 7. Output setelah perbaikan

### 7.1 Request default

```http
GET /api/admin/loyalty-summary HTTP/1.1
Cookie: crisbar_session=<session>
```

Mengembalikan maksimal 25 record riwayat terbaru.

### 7.2 Request halaman tertentu

```http
GET /api/admin/loyalty-summary?redemption_history_page=3&redemption_history_limit=50 HTTP/1.1
Cookie: crisbar_session=<session>
```

Mengembalikan record ke-101 sampai ke-150 sesuai urutan `redeemed_at DESC`,
jika tersedia.

### 7.3 Request dengan filter

```http
GET /api/admin/loyalty-summary?redemption_from=2026-08-01&redemption_to=2026-08-31&outlet_id=12&redemption_history_page=1&redemption_history_limit=25 HTTP/1.1
```

Filter tanggal dan outlet yang sama diterapkan pada:

- total redemption;
- top rewards;
- agregasi per outlet;
- tren harian SQL;
- halaman riwayat detail;
- metadata total pagination.

### 7.4 Contoh response baru

```json
{
  "redemption_count": 1250,
  "redemption_trend": [
    {
      "date": "2026-08-01",
      "redemption_count": 15,
      "points_spent": 3000
    }
  ],
  "redemption_history": [
    {
      "id": "12345",
      "reward_id": 7,
      "runchise_product_id": 7001,
      "reward_name": "Ayam Crispy",
      "quantity": 1,
      "point_per_item": 200,
      "points_spent": 200,
      "menu_price": 12000,
      "outlet_id": 12,
      "runchise_location_id": 101,
      "outlet_name": "Crisbar Outlet A",
      "outlet_city": "Bandung",
      "redeemed_at": "2026-08-01T10:30:00.000Z"
    }
  ],
  "redemption_history_pagination": {
    "page": 1,
    "limit": 25,
    "total": 1250,
    "total_pages": 50
  }
}
```

Tidak ada nama, nomor telepon, maupun ID customer dalam history response.

### 7.5 Limit di atas batas

```http
GET /api/admin/loyalty-summary?redemption_history_limit=10000
```

Server mengunci nilai efektif menjadi 100:

```json
{
  "redemption_history_pagination": {
    "page": 1,
    "limit": 100,
    "total": 1250,
    "total_pages": 13
  }
}
```

## 8. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Query history | `findMany` tanpa batas | `skip` + `take` |
| Default jumlah detail | Seluruh tabel/rentang | 25 record |
| Batas maksimum | Tidak ada | 100 record |
| Tren harian | Loop seluruh redemption di Node.js | `DATE_TRUNC` + `SUM` di PostgreSQL |
| Pertumbuhan memori detail | Mengikuti seluruh jumlah transaksi | Dibatasi page size |
| Field query | Model + relasi | Whitelist `select` |
| Nama customer | Dikirim | Tidak dibaca/tidak dikirim |
| Nomor telepon | Dikirim | Tidak dibaca/tidak dikirim |
| ID customer | Dikirim | Tidak dibaca/tidak dikirim |
| Metadata pagination | Tidak ada | Page, limit, total, total pages |
| Outlet tidak ditemukan | Dapat jatuh ke semua outlet | Request ditolak |
| Akses route | Admin dan marketing | Tetap admin dan marketing, tetapi response diminimalkan |

## 9. Verifikasi

### 9.1 Unit test privasi

Test memberikan object input yang sengaja mengandung:

- `customer_id`;
- `runchise_customer_id`;
- `customer_name`;
- `customer_phone_number`.

Hasil `toPublicRedemptionHistory()` diverifikasi tidak memiliki keempat
property tersebut:

```text
ok - proyeksi history tidak pernah mengekspos PII customer
```

### 9.2 Unit test tren

Hasil tiruan agregasi SQL diverifikasi menjadi JSON-safe number dan tanggal
harian:

```text
ok - hasil agregasi SQL dinormalisasi menjadi angka JSON dan tanggal harian
```

### 9.3 Hasil seluruh test suite backend

```text
$ npm test

tests 5
pass 5
fail 0
cancelled 0
skipped 0
```

Dua dari lima test tersebut merupakan test khusus H-4. Tiga lainnya adalah
test sinkronisasi multi-outlet H-3 yang tetap lulus sebagai regression check.

### 9.4 Pemeriksaan teknis

```text
node --check src/controllers/adminLoyaltyController.js
node --check src/lib/loyaltySummaryProjection.js

Exit code: 0
```

```text
npx eslint src/lib/admin.ts

Exit code: 0
```

```text
npm run build

Client build: berhasil
SSR build: berhasil
Nitro/Vercel build: berhasil
Exit code: 0
```

```text
git diff --check

Exit code: 0
```

Pengujian query terhadap database production dan benchmark volume besar tidak
dilakukan dalam perbaikan ini agar tidak membaca PII atau menambah beban pada
production. Karena itu dokumen ini tidak mengklaim angka penurunan latency atau
penggunaan memori tertentu.

## 10. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Hitung tren dengan `date_trunc` SQL | Raw query parameterized memakai `DATE_TRUNC('day', redeemed_at)` dan `SUM` |
| Jangan `findMany` seluruh tabel | History selalu memakai `skip` dan `take` |
| Batasi/paginasi daftar riwayat | Default 25, hard maximum 100, metadata pagination lengkap |
| Hilangkan PII dari endpoint ringkasan | Prisma `select` dan projection whitelist sama-sama mengecualikan nama, telepon, dan ID customer |
| Cegah exposure akibat filter salah | `outlet_id` yang tidak ditemukan ditolak, bukan menjadi query semua outlet |
| Jaga kompatibilitas dashboard | `redemption_trend` dan `redemption_history` tetap tersedia dengan field yang benar-benar dipakai UI |

## 11. Yang tidak berubah

- Route tetap membutuhkan autentikasi dan role `admin` atau `marketing`.
- Struktur metrik utama seperti `total_members`, `points_redeemed`,
  `top_rewards`, dan `top_redeem_outlets` tidak berubah.
- Filter `redemption_from`, `redemption_to`, dan `outlet_id` tetap tersedia.
- Urutan history tetap terbaru dahulu berdasarkan `redeemed_at DESC`.
- Grafik tren tetap menerima `date`, `redemption_count`, dan `points_spent`.
- Tabel dashboard tetap menerima nama reward, outlet, poin, harga, dan tanggal.
- Tidak ada migration atau perubahan skema database.
- Index gabungan `is_managed_reward`, `status`, dan `redeemed_at` yang sudah ada
  tetap dapat membantu filter query.

## 12. Risiko residual dan tindak lanjut

- Agregasi tren tanpa filter tanggal tetap memindai histori valid untuk
  menghasilkan seluruh rentang hari, walaupun hasilnya jauh lebih kecil dan
  agregasi dilakukan database. Dashboard sebaiknya memakai rentang tanggal
  default bila histori sudah sangat panjang.
- Offset pagination (`skip`) dapat melambat pada halaman yang sangat jauh.
  Cursor pagination berdasarkan `(redeemed_at, id)` dapat digunakan bila
  kebutuhan browsing histori mendalam muncul.
- Endpoint masih dapat diakses marketing karena dashboard memang digunakan
  role tersebut. Perbaikan ini menerapkan minimisasi data; pemisahan metrik
  tertentu menjadi admin-only dapat dipertimbangkan berdasarkan kebutuhan
  bisnis.
- PII masih tersimpan di tabel sumber untuk kebutuhan proses lain. Perbaikan ini
  hanya memastikan PII tidak dibaca dan tidak keluar melalui endpoint summary.
- Rate limiting global tetap menjadi lapisan perlindungan terhadap request
  berulang. Cache summary jangka pendek dapat ditambahkan jika beban agregasi
  database masih tinggi setelah pengukuran staging.

## 13. Checklist deployment dan monitoring

1. Deploy backend dan frontend secara berpasangan agar tipe metadata pagination
   langsung dikenali frontend.
2. Uji response staging dan pastikan tidak ada key `customer_name`,
   `customer_phone_number`, `customer_id`, atau `runchise_customer_id` pada
   `redemption_history`.
3. Pastikan response default berisi maksimal 25 history item.
4. Pastikan request limit lebih dari 100 tetap menghasilkan `limit: 100`.
5. Uji page 1, page tengah, dan page setelah `total_pages`.
6. Uji filter tanggal dan outlet; bandingkan total trend dengan agregat sumber.
7. Uji `outlet_id` yang tidak ditemukan dan pastikan request ditolak.
8. Pantau latency, ukuran response, penggunaan heap, dan waktu query sebelum
   serta sesudah rollout.
9. Tambahkan alert bila latency summary atau penggunaan memori kembali naik
   mengikuti pertumbuhan data.
