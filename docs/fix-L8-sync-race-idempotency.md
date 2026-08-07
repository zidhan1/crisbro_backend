# L8 — Idempotensi Sinkronisasi Customer terhadap Race Condition

## Kondisi sebelumnya

`syncService.js` lebih dulu membaca customer berdasarkan `runchise_id` dan
nomor telepon, lalu memilih operasi `create`. Dua worker yang berjalan pada
waktu hampir bersamaan dapat sama-sama melihat data kosong dan sama-sama
mencoba membuat user/customer. Pemeriksaan tersebut bukan lock dan tidak dapat
menjamin keunikan antar-instance.

## Perubahan

- Constraint unik database (`User.phone_number`, `Customer.runchise_id`, serta
  relasi unik yang sudah ada) menjadi sumber kebenaran untuk operasi create.
- Create tetap atomik melalui nested Prisma create atau transaksi bulk.
- Error Prisma `P2002` ditangkap khusus sebagai konflik konkurensi.
- Setelah konflik, service membaca baris pemenang dan menjalankan rekonsiliasi
  update pada baris tersebut (`updated_after_conflict`), sehingga retry tidak
  membuat baris kedua.
- Jika nomor telepon dimenangkan oleh user non-customer, hasil tetap
  `skipped_conflict` dan tidak menimpa akun tersebut.
- Bulk create yang kalah race diulang per customer melalui jalur conflict-safe;
  error lain tetap dilempar agar kegagalan tidak disembunyikan.

Pemeriksaan awal masih dipakai untuk mendeteksi konflik data yang bermakna,
tetapi bukan lagi jaminan keunikan. Jaminan tersebut berasal dari constraint
unik database dan penanganan `P2002`.

## Output

Run normal menghasilkan `created` atau `updated`. Jika dua run overlap dan satu
run memenangkan insert, run lain menghasilkan:

```json
{
  "status": "updated_after_conflict",
  "customer_id": 501,
  "unresolved_location_ids": []
}
```

Tidak ada user/customer duplikat. Konflik dengan user non-customer tetap
menghasilkan `skipped_conflict` untuk menjaga akun yang sudah ada.

## Pengukuran dan verifikasi

Test `syncRaceConflict.test.js` memaksa `P2002` dari create, memastikan create
hanya dicoba sekali, satu transaksi update dijalankan, dan ID customer pemenang
dipakai. Jalankan seluruh suite dengan:

```powershell
npm test
```

Constraint unik harus sudah diterapkan melalui migrasi Prisma sebelum worker
dijalankan pada environment baru. Jangan menghapus constraint untuk mengurangi
error konflik; constraint itulah pagar terakhir antar-instance.
