# L-6 (LOW) — Sync customer membuat Location palsu

Status: **Fixed**

File terdampak:

- `src/services/syncService.js`
- `test/upsertCustomerIdempotency.test.js`

## 1. Masalah

`upsertRunchiseCustomer` dan jalur batch sebelumnya memperlakukan ID
membership lokasi dari payload customer sebagai primary key `Location` lokal.
Jika lokasi belum ada, proses customer membuatnya sendiri:

```js
await prisma.location.upsert({
  where: { id: locationId },
  update: {
    brand_id: c.brand_id,
    runchise_id: locationId,
  },
  create: {
    id: locationId,
    brand_id: c.brand_id,
    runchise_id: locationId,
    name: `Outlet ${locationId}`,
    is_active: true,
    is_outlet: true,
  },
});
```

Jalur batch melakukan hal yang sama melalui raw SQL `INSERT INTO
"Location"`, termasuk hardcode `true, true` untuk `is_active` dan
`is_outlet`.

## 2. Dampak

- Membership customer dapat membuat outlet yang tidak pernah berasal dari
  endpoint master Location Runchise.
- Cabang non-outlet atau lokasi nonaktif dapat salah ditandai sebagai outlet
  aktif.
- `Location.id` lokal dan `Location.runchise_id` adalah namespace berbeda.
  Memaksa keduanya sama dapat menabrak primary key lokal milik lokasi lain.
- Nama placeholder seperti `Outlet 4424` dapat tampil di dashboard dan
  laporan sebagai outlet nyata.
- Payload customer, yang bukan sumber kebenaran lokasi, dapat menimpa brand,
  nama, dan mapping lokasi master.

## 3. Kondisi sebelum perbaikan

Misalnya customer membawa membership Runchise berikut:

```json
{
  "id": 900123,
  "owner_location_id": 4424,
  "location_ids": [4424]
}
```

Walaupun master Location 4424 belum pernah disinkronkan, proses membuat:

```text
Location {
  id: 4424,
  runchise_id: 4424,
  name: "Outlet 4424",
  is_active: true,
  is_outlet: true
}
```

Kemudian `Customer.owner_location_id` dan `CustomerLocation.location_id`
langsung menunjuk `4424`.

## 4. Perbaikan

### 4.1 Membership tidak lagi membuat atau memperbarui Location

Seluruh `location.upsert` dan bulk `INSERT INTO "Location"` di jalur sync
customer dihapus. Hanya `syncLocations`, yang membaca endpoint master lokasi,
yang berwenang membuat dan memperbarui `Location`, termasuk menentukan
`is_active` dan `is_outlet` dari data Runchise sebenarnya.

### 4.2 Pemisahan ID Runchise dan primary key lokal

ID membership customer dicari hanya melalui kolom `runchise_id`:

```js
const locationRows = await prisma.location.findMany({
  where: { runchise_id: { in: uniqueIds } },
  select: { id: true, runchise_id: true },
});
```

Contoh mapping yang valid:

```text
Membership dari API: runchise location ID = 4424
Location master:      id lokal = 77, runchise_id = 4424
CustomerLocation:     location_id = 77
```

Tidak ada fallback pencarian melalui `Location.id`, sehingga kebetulan
primary key lokal sama dengan ID Runchise tidak dapat menyebabkan salah
hubung atau tabrakan.

### 4.3 Lokasi hilang atau ambigu gagal secara aman

Jika master lokasi belum tersedia:

- customer tetap dapat disinkronkan;
- `Customer.runchise_location_id` tetap menyimpan ID sumber untuk
  rekonsiliasi berikutnya;
- `Customer.owner_location_id` diset `null`, bukan FK palsu;
- tidak ada baris `CustomerLocation` untuk ID yang tidak terpetakan;
- tidak ada baris `Location` yang dibuat;
- ID tersebut ditulis ke warning log dan dikembalikan dalam
  `unresolved_location_ids`.

Jika lebih dari satu Location lokal memiliki `runchise_id` yang sama, mapping
dianggap ambigu dan juga tidak digunakan. Proses tidak memilih salah satu
secara acak.

### 4.4 Batch tetap efisien

Semua membership satu batch disatukan dan di-resolve melalui satu query
`Location.findMany`, bukan satu query per customer. Hasil mapping dipakai
ulang untuk semua customer pada batch tersebut.

ID lokal hasil mapping juga dideduplikasi sebelum insert relasi untuk
mencegah konflik apabila data master tidak konsisten.

### 4.5 Hasil sinkronisasi terukur

Hasil per-customer sekarang dapat memuat:

```json
{
  "status": "created",
  "customer_id": 8001,
  "unresolved_location_ids": [4424]
}
```

Ringkasan `syncCustomers` menambahkan jumlah membership yang belum dapat
dipetakan:

```json
{
  "synced": 10,
  "total": 10,
  "skipped_conflicts": 0,
  "failed": 0,
  "unresolved_location_memberships": 2
}
```

Ini memungkinkan monitoring dan rekonsiliasi tanpa menciptakan data master
palsu.

## 5. Output setelah perbaikan

### Master lokasi tersedia

Input:

```text
Customer membership: 4424
Location master: { id: 77, runchise_id: 4424, is_active: false, is_outlet: true }
```

Output database:

```text
Customer.owner_location_id = 77
Customer.runchise_location_id = 4424
CustomerLocation.location_id = 77
Location.id = 77 tetap is_active=false (tidak disentuh sync customer)
```

### Master lokasi belum tersedia

Output database:

```text
Customer.owner_location_id = null
Customer.runchise_location_id = 4424
Tidak ada CustomerLocation untuk 4424
Tidak ada Location baru
```

Log:

```text
Sync customer runchise_id=900123: membership lokasi belum dapat dipetakan: 4424
```

## 6. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Sumber pembuatan Location | Master location dan membership customer | Hanya sync master location |
| Mapping membership | `Location.id = ID Runchise` | `Location.runchise_id -> Location.id lokal` |
| Lokasi master tidak ditemukan | Membuat outlet placeholder | Relasi dilewati, ID sumber dipertahankan |
| `is_active` / `is_outlet` | Dihardcode `true` | Tidak disentuh sync customer |
| Nama/brand Location | Dapat ditimpa payload customer | Tidak disentuh sync customer |
| Mapping duplikat/ambigu | Dapat memilih/menimpa data berdasarkan ID | Ditolak secara aman |
| Observabilitas | Tidak ada indikasi ghost location | Warning + `unresolved_location_ids` + counter ringkasan |
| Query lokasi pada batch | Bulk write Location | Satu read terparameterisasi |

## 7. Verifikasi otomatis

Test regresi memverifikasi:

1. membership Runchise 4424 dipetakan ke primary key lokal 77;
2. lookup menggunakan `where.runchise_id`, bukan `where.id`;
3. tidak ada `INSERT INTO "Location"` dari sync customer;
4. `CustomerLocation` menyimpan ID lokal 77 dan tidak menyimpan 4424;
5. membership tanpa master tidak menghasilkan relasi atau Location palsu;
6. ID tanpa mapping dilaporkan melalui `unresolved_location_ids`;
7. idempotensi create/update customer yang sudah ada tetap terjaga.

Perintah:

```text
node --test test/upsertCustomerIdempotency.test.js
npm test
node --check src/services/syncService.js
```

## 8. Yang tidak berubah

- `syncLocations` tetap menjadi proses sinkronisasi master Location.
- Data customer selain FK lokasi tetap mengikuti alur upsert sebelumnya.
- `runchise_location_id` tetap menyimpan ID lokasi dari sumber Runchise.
- Konflik nomor telepon dan idempotensi customer tidak berubah.
- Tidak ada dependency, migration, atau environment variable baru.

## 9. Checklist deployment dan rekonsiliasi

1. Jalankan sync master Location sebelum sync customer agar sebanyak mungkin
   membership langsung terhubung.
2. Pantau `unresolved_location_memberships` dan warning log setelah deploy.
3. Jika nilainya bukan nol, periksa apakah lokasi memang belum masuk dari API
   master atau terdapat `runchise_id` duplikat di database.
4. Setelah master lokasi diperbaiki/disinkronkan, jalankan ulang sync customer
   untuk membentuk relasi yang sebelumnya dilewati.
5. Perbaikan ini mencegah ghost location baru tetapi tidak otomatis menghapus
   baris placeholder lama. Audit dan penghapusan data lama harus dilakukan
   terpisah setelah memastikan baris tersebut tidak merupakan Location master
   yang valid.
