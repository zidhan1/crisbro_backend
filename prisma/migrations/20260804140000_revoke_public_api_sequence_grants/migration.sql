-- Melengkapi 20260804130000_revoke_public_api_grants yang baru mencabut hak
-- atas tabel. Role anon & authenticated masih memegang SELECT/UPDATE/USAGE atas
-- 26 sequence di schema public, sehingga pemegang anon key masih bisa:
--   1. membaca last_value, yang membocorkan perkiraan jumlah baris tiap tabel
--      (berapa customer, berapa user, berapa transaksi);
--   2. memanggil nextval() berulang kali. Kolom id memakai int4 (batas
--      2.147.483.647), jadi sequence yang digenjot terus bisa habis dan membuat
--      INSERT berikutnya gagal.
--
-- Default privileges untuk FUNCTION ikut dicabut. Saat ini belum ada function
-- buatan sendiri di schema public, jadi tidak ada yang terdampak; ini mencegah
-- function yang dibuat nanti otomatis bisa dieksekusi lewat kunci API publik.
--
-- Aman untuk aplikasi: seluruh sequence dimiliki role `postgres`, yaitu role
-- yang dipakai Prisma, dan pemilik selalu punya hak penuh atas objeknya sendiri.
--
-- Untuk membalik:
--   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

-- 1. Sequence yang sudah ada.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 2. Sequence yang dibuat nanti.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- 3. Function yang dibuat nanti.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
