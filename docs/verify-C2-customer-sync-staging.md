# Verifikasi operasional C-2 customer sync

Perbaikan kode menetapkan budget efektif worker impor customer ke **20 detik**.
Runtime function tetap 30 detik dan 10 detik terakhir dicadangkan untuk
checkpoint cursor, advisory unlock, penutupan koneksi, serta response.

Sinkronisasi aktif secara default. Untuk pause darurat, setel flag ke `false`;
jangan mengandalkan env yang hilang sebagai mekanisme operasi.

## Konfigurasi staging

Set environment berikut pada scope **staging/preview** lalu redeploy:

```env
RUNCHISE_CUSTOMER_SYNC_ENABLED=true
RUNCHISE_CUSTOMER_WORKER_BUDGET_MS=20000
RUNCHISE_CUSTOMER_WORKER_MAX_PAGES=20
```

`RUNCHISE_CUSTOMER_WORKER_BUDGET_MS` dijepit ke rentang 3.000-20.000 ms dan
`RUNCHISE_CUSTOMER_WORKER_MAX_PAGES` ke 1-20. Nilai di atas batas tidak dapat
membuat worker melewati reserve serverless.

## Langkah pengukuran

1. Pastikan endpoint status mengembalikan `sync_enabled: true` dan
   `worker_config: { timeBudgetMs: 20000, maxPages: 20 }`.
2. Buat satu job customer, lalu biarkan cron worker `*/10 * * * *` memprosesnya.
3. Pantau `SyncJobTelemetry` untuk job `customers-import-worker`. Catat setiap
   invocation: `duration_ms`, `fetched`, `synced`, `failed`,
   `current_location`, dan `cursor`.
4. Hitung throughput dari selisih `fetched` antar-invocation, bukan dari counter
   kumulatif satu baris job. Catat p50/p95 durasi dan halaman per invocation.
5. Job harus mencapai `completed`/`completed_with_errors`; cursor harus terus
   maju, dan tidak boleh ada rangkaian timeout/requeue pada halaman yang sama.

## Kriteria penerimaan

- satu pass seluruh outlet staging selesai;
- tidak ada invocation melewati 30 detik;
- tidak ada cursor macet selama tiga invocation berturut-turut;
- `failed` dan `completed_with_errors` sudah ditinjau;
- pertumbuhan jumlah Customer/User dan ukuran database masih dalam kapasitas;
- estimasi penyelesaian production dihitung dari throughput p50 dan p95 aktual.

Setelah seluruh kriteria terpenuhi, deploy ke production dan pantau invocation
pertama. Rollback aman dilakukan dengan mengubah flag menjadi `false`; job dan
cursor tetap tersimpan dan dapat dilanjutkan. Jika env tidak dikonfigurasi,
perilaku tetap aktif (default-on).
