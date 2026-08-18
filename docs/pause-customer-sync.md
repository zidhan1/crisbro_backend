# Menjeda sinkronisasi customer Runchise

Sinkronisasi customer aktif secara default. Cron enqueue berjalan harian pada
`15 12 * * *`, sedangkan worker cursor berjalan setiap 10 menit (`*/10 * * * *`).
Worker hanya melanjutkan job aktif dan tidak membuat full-import baru saat idle.

## Saklar operasi

`isCustomerSyncEnabled()` menganggap sinkronisasi aktif bila environment tidak
berisi string `RUNCHISE_CUSTOMER_SYNC_ENABLED=false`. Deployment baru dengan
env kosong tetap berjalan; ini mencegah antrean customer diam-diam tidak pernah
diproses. Untuk pause darurat, setel nilai tersebut ke `false` dan deploy ulang.
Untuk mengaktifkan kembali, hapus variable atau setel ke `true`.

Saat pause, seluruh entry point (enqueue, worker impor, dan worker timestamp)
keluar sebelum membuka koneksi database dan mengembalikan
`{ status: 'disabled', reason: 'customer_sync_disabled' }`. Job dan cursor tidak
dihapus atau dibatalkan, sehingga proses dapat dilanjutkan dari halaman terakhir.

## Dashboard dan verifikasi

Dashboard membaca `sync_enabled`, menghentikan polling/proses saat `false`, dan
menampilkan status dijeda. Test `test/customerSyncToggle.test.js` memverifikasi
default-on, pause eksplisit, preservasi cursor, dan jalur tanpa koneksi database.

Budget worker impor default 20 detik dengan batas keselamatan 20 halaman;
time guard tetap mencegah request baru ketika reserve runtime serverless terpakai.
