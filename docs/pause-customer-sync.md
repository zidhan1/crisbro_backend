# Menjeda sinkronisasi customer Runchise (sementara)

Status: **dijeda** — impor customer baru dari Runchise dimatikan sampai
kapasitas database ditambah. Aplikasi memakai data customer yang sudah
tersimpan.

## 1. Kenapa banner "Sinkronisasi customer sedang berjalan" muncul

Ada **dua** pemicu terpisah, dan yang kedua sering luput:

1. **Vercel Cron** `/api/cron/runchise-sync/customers` (harian 12:15 UTC) →
   `runCustomerImportWorkerJob()` → membuat job bila belum ada, lalu
   memproses beberapa halaman.

2. **Browser admin itu sendiri.** `AdminPage.tsx` punya polling: selama tab
   **Customers** terbuka, setiap **5 detik** dashboard memanggil
   `/sync/customers/status`, dan bila melihat job berstatus `queued`/
   `running` ia memanggil `/sync/customers/process` — jadi tab yang dibiarkan
   terbuka **ikut memajukan impor halaman demi halaman**, terlepas dari cron.

Karena itu mematikan cron saja tidak cukup; selama ada job `queued`/`running`
dan ada admin yang membuka tab Customers, impor tetap berjalan.

Baris job tersimpan di tabel `CustomerImportSyncJob` beserta cursor-nya
(`current_location_index`, `current_page`).

## 2. Apa yang diubah

### 2.1 Saklar tunggal, opt-in

`src/lib/customerSyncToggle.js` — `isCustomerSyncEnabled()` hanya bernilai
`true` bila env `RUNCHISE_CUSTOMER_SYNC_ENABLED` berisi string **`"true"`
persis**. Default (env kosong/tidak ada) = **mati**, sehingga tidak ada nilai
setengah benar (`1`, `yes`, `TRUE`) yang diam-diam menghidupkannya lagi.

### 2.2 Worker berhenti tanpa menyentuh database

Penjaga dipasang di **empat** titik masuk:

| Service | Fungsi |
|---|---|
| `customerImportSyncService.js` | `createCustomerImportSyncJob`, `processCustomerImportSyncJob` |
| `customerTimestampSyncService.js` | `createCustomerTimestampSyncJob`, `processCustomerTimestampSyncJob` |

Saat dijeda, keempatnya keluar **sebelum** `createDatabaseClient()` dipanggil
— nol koneksi, nol query — dan mengembalikan
`{ status: 'disabled', reason: 'customer_sync_disabled' }`.

Worker timestamp ikut dijeda karena juga menyapu endpoint customer Runchise
halaman demi halaman untuk seluruh outlet.

### 2.3 Cron dimatikan

Dua entri dihapus dari `vercel.json`:

```text
/api/cron/runchise-sync/customers
/api/cron/runchise-sync/customer-timestamps-worker
```

Tujuh cron lain (locations, brands, products, sales-transactions, promos,
points, maintenance) **tidak** disentuh.

### 2.4 Dashboard berhenti menggerakkan worker

`/sync/customers/status` kini mengembalikan `sync_enabled`. Bila `false`,
`AdminPage.tsx`:

- **tidak** memanggil `/sync/customers/process`;
- **menghentikan** polling 5 detik (flag `stopped`, dibedakan dari
  `cancelled` yang berarti komponen unmount);
- menampilkan "Sinkronisasi customer **dijeda sementara**" alih-alih "sedang
  berjalan", plus keterangan bahwa progres tersimpan;
- menonaktifkan tombol "Sinkronkan Customer Runchise" dan menghentikan
  animasi spinner-nya.

## 3. Dijeda, BUKAN dibatalkan

Tidak ada baris database yang dihapus atau diubah statusnya. Job yang
berstatus `queued`/`running` dibiarkan apa adanya beserta cursor-nya, jadi
ketika saklar dinyalakan lagi worker **melanjutkan dari halaman terakhir**,
bukan mengulang dari nol.

Tidak ada migration dan tidak ada data customer yang dihapus.

## 4. Cara mengaktifkan kembali (nanti, setelah database diperbesar)

1. Set environment variable di Vercel (Project → Settings → Environment
   Variables):

   ```env
   RUNCHISE_CUSTOMER_SYNC_ENABLED=true
   ```

2. Kembalikan dua entri cron di `vercel.json`:

   ```json
   { "path": "/api/cron/runchise-sync/customers", "schedule": "15 12 * * *" },
   { "path": "/api/cron/runchise-sync/customer-timestamps-worker", "schedule": "35 12 * * *" }
   ```

3. Deploy ulang.

Tanpa langkah 1, langkah 2 tidak berefek — cron akan memanggil worker dan
worker tetap membalas `disabled`.

## 5. Verifikasi

`test/customerSyncToggle.test.js` (7 test, lulus):

- saklar mati saat env kosong; hanya `"true"` persis yang menyalakan
  (`false`, `TRUE`, `True`, `1`, `yes`, `on`, `""`, `" true "` semuanya mati);
- balasan `disabled` bisa dibedakan dari `idle`/`already_running`/`running`;
- menjeda tidak mengubah status maupun cursor job;
- worker impor **dan** worker timestamp: `pg.Client` diganti tiruan yang
  melempar error pada `connect()`/`query()` — terbukti nol koneksi
  (`clientsCreated === 0`);
- begitu saklar dinyalakan, worker benar-benar berjalan lagi (bukan sekadar
  berhenti melempar `disabled`).

Hasil: backend **77/77 lulus**, frontend **38/38 lulus**, `vite build` sukses,
`tsc` tetap 5 error pre-existing (tidak berhubungan).

## 6. Catatan

- `POST /admin/sync/customers` (tombol dashboard) kini membalas
  `{ created: false, status: 'disabled', ... }`. Tombolnya sendiri sudah
  dinonaktifkan di UI.
- Cron `points` (`syncCustomerPointsFromStaging`) **tidak** dijeda: ia membaca
  tabel staging lokal, tidak memanggil API customer Runchise dan tidak
  membuat baris customer baru.
