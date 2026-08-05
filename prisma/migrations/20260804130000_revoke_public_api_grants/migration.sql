-- Menutup penyebab sistemik di balik temuan rls_disabled_in_public.
--
-- Default privileges bawaan Supabase memberi anon & authenticated hak penuh
-- (SELECT/INSERT/UPDATE/DELETE) atas setiap tabel baru di schema public. Karena
-- Prisma membuat tabel sebagai role `postgres`, setiap migration yang menambah
-- tabel otomatis membuka tabel itu ke kunci API publik, dan RLS jadi satu-satunya
-- penahan. Migration sebelumnya sudah menyalakan RLS di semua tabel; di sini
-- haknya dicabut sekalian supaya RLS tidak berdiri sendiri.
--
-- Aman untuk aplikasi: Prisma terhubung sebagai `postgres` (pemilik seluruh
-- tabel), dan proyek ini tidak memakai supabase-js/PostgREST sama sekali.
--
-- Untuk membalik: GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
--                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

-- 1. Cabut hak atas tabel yang sudah ada.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 2. Cegah tabel baru mendapat hak yang sama. Berlaku untuk objek yang dibuat
--    oleh role `postgres`, yaitu role yang dipakai Prisma saat migrate.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
