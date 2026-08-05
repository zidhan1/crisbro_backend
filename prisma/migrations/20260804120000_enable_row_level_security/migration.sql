-- Menutup temuan Supabase: rls_disabled_in_public & sensitive_columns_exposed.
--
-- Role `anon` (kunci API publik) memegang SELECT/INSERT/UPDATE/DELETE atas
-- seluruh tabel di schema public karena default privileges bawaan Supabase.
-- Selama Row-Level Security mati dan tidak ada policy, siapa pun yang memegang
-- URL project + anon key bisa membaca dan mengubah isi tabel tersebut.
--
-- Aplikasi tidak terpengaruh: Prisma terhubung sebagai role `postgres` yang
-- memiliki atribut BYPASSRLS, dan proyek ini tidak memakai supabase-js sama
-- sekali (tidak ada dependency maupun pemakaian di source).
--
-- Sengaja TIDAK dibuat policy apa pun. RLS aktif tanpa policy berarti tolak
-- semua untuk role non-bypass, yaitu persis yang diinginkan: seluruh akses data
-- harus lewat API backend, bukan lewat PostgREST.
--
-- Ditulis sebagai loop agar tabel yang RLS-nya sudah aktif tidak tersentuh dan
-- tidak ada nama tabel yang terlewat.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = false
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      target.relname
    );
    RAISE NOTICE 'RLS diaktifkan: %', target.relname;
  END LOOP;
END $$;
