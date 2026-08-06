# M-3 — Distributed advisory lock untuk cron Runchise

## Ringkasan

Cron Runchise kini memakai PostgreSQL advisory lock per jenis job. Hanya satu invocation untuk job yang sama yang dapat berjalan pada saat bersamaan, termasuk ketika invocation berasal dari proses, container, atau instance serverless yang berbeda.

Perubahan mencakup job `locations`, `brands`, `products`, `customers-full`, `customers-import`, `sales`, `promos`, dan `points`.

## Sebelum perubahan

`runchiseSyncCron.js` memakai boolean seperti `salesRunning` dan `pointsRunning` sebagai mutex:

```js
if (salesRunning) return { skipped: true };
salesRunning = true;
try {
  return await syncSalesTransactionReports();
} finally {
  salesRunning = false;
}
```

Boolean tersebut hanya hidup di memori satu proses. Dua invocation Vercel berjalan di proses berbeda, sehingga keduanya melihat nilai awal `false` dan menjalankan sinkronisasi yang sama. Dampaknya adalah request upstream ganda, upsert bersamaan, beban database meningkat, dan hasil/log yang sulit diprediksi.

`node-cron` juga tidak dapat dijadikan scheduler utama pada serverless karena proses dapat dihentikan dan tidak selalu hidup pada waktu jadwal tiba.

## Setelah perubahan

Utilitas `src/lib/distributedCronLock.js` sekarang:

1. Membuka satu koneksi PostgreSQL khusus.
2. Memanggil `pg_try_advisory_lock(namespace, jobId)` dengan key stabil dan berbeda untuk setiap job.
3. Menjalankan callback hanya jika lock berhasil diperoleh.
4. Memanggil `pg_advisory_unlock` pada blok `finally` menggunakan koneksi dan key yang sama.
5. Menutup koneksi dan membersihkan mutex lokal walaupun job gagal.

Mutex lokal `Set` tetap ada sebagai optimasi agar overlap pada proses yang sama tidak membuka koneksi database kedua. Mutex ini bukan lagi kontrol konkurensi utama.

Session lock dipilih mengikuti pola worker yang sudah ada. Koneksi khusus penting karena advisory lock PostgreSQL melekat pada session; acquire dan unlock melalui koneksi pool yang berbeda tidak aman.

## Contoh output

Invocation pertama memperoleh lock dan berjalan normal:

```text
[runchise-sync:sales] started
[runchise-sync:sales] finished { locations_total: 29, locations_succeeded: 29, ... }
```

Invocation kedua untuk job sales pada waktu yang sama tidak menjalankan sinkronisasi:

```json
{
  "message": "Cron sync runchise-sales-transactions dilewati karena job masih aktif",
  "status": "skipped",
  "job": "runchise-sales-transactions",
  "result": {
    "skipped": true,
    "reason": "distributed_lock_busy",
    "job": "runchise-sync:sales"
  }
}
```

Overlap pada proses Node yang sama menghasilkan:

```json
{
  "skipped": true,
  "reason": "local_lock_busy",
  "job": "runchise-sync:sales"
}
```

Field `reason` membuat skip dapat dibedakan dan diukur melalui log/monitoring, bukan sekadar `{ "skipped": true }` tanpa penyebab.

## Stabilitas dan keamanan kegagalan

- Lock berbeda per job: sales tidak menghambat promo, tetapi dua sales tidak dapat overlap.
- Error koneksi atau query lock menggagalkan job secara eksplisit; sinkronisasi tidak berjalan tanpa guard.
- `finally` selalu mencoba unlock dan menutup koneksi.
- Jika proses serverless mati mendadak, PostgreSQL melepas session lock ketika koneksi terputus.
- Kegagalan unlock dicatat tanpa menutupi error asli dari job.

## Pengujian terukur

`test/distributedCronLock.test.js` memverifikasi:

- callback tidak dipanggil ketika lock global sibuk;
- overlap lokal ditolak tanpa membuat koneksi kedua;
- job gagal tetap melakukan unlock dan menutup koneksi;
- mutex lokal bersih setelah error sehingga invocation berikutnya tidak macet permanen;
- unlock memakai namespace dan job ID yang sama dengan acquire.

Jalankan:

```bash
npm test
```

## Yang belum dan perlu dilakukan di deployment

Perubahan ini memperbaiki kontrol konkurensi, bukan membuat `node-cron` menjadi scheduler serverless. Pada Vercel, endpoint `/api/cron/runchise-sync/*` tetap harus dipicu oleh Vercel Cron atau scheduler eksternal. `startRunchiseSyncCron()` hanya relevan untuk proses Node persisten/non-serverless.

Invocation yang mendapat `distributed_lock_busy` sengaja dilewati, bukan dimasukkan antrean. Scheduler harus memiliki interval berikutnya, dan monitoring sebaiknya memberi alarm bila suatu job terus-menerus skip atau tidak pernah menghasilkan run sukses.

Untuk pengukuran produksi, pantau per `job`:

- jumlah run sukses/gagal;
- jumlah `local_lock_busy` dan `distributed_lock_busy`;
- durasi eksekusi;
- waktu run sukses terakhir.

## File yang berubah

- `src/lib/distributedCronLock.js`
- `src/jobs/runchiseSyncCron.js`
- `src/index.js`
- `test/distributedCronLock.test.js`
- `docs/fix-M3-distributed-cron-advisory-lock.md`
