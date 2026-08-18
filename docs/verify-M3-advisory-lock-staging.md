# Verifikasi M-3 advisory lock di staging

Semua session-level advisory lock memakai `DIRECT_URL`. Pada seluruh runtime
(termasuk development dan test), proses lock gagal dengan kode
`DIRECT_URL_REQUIRED_FOR_ADVISORY_LOCK` bila variabel tersebut tidak tersedia;
tidak ada fallback diam-diam ke transaction pooler.

Set `DIRECT_URL` staging ke endpoint PostgreSQL direct/session-mode, redeploy,
lalu jalankan dari environment yang menggunakan nilai staging tersebut:

```text
npm run verify:advisory-lock
```

Hasil yang diterima:

```json
{
  "status": "passed",
  "separate_backend_sessions": true,
  "second_blocked_while_first_held_lock": true,
  "second_acquired_after_release": true
}
```

Script hanya mengambil dan melepas advisory lock verifikasi. Tidak membaca
atau menulis tabel bisnis. Production baru layak diteruskan bila smoke test ini
lulus terhadap `DIRECT_URL` staging dan dua invocation endpoint cron paralel
menghasilkan satu eksekusi serta satu `distributed_lock_busy`/
`already_running`.
