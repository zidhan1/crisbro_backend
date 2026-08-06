  # Crisbar Backend

  Backend API untuk aplikasi loyalty Crisbar/Crisbro. Aplikasi ini menangani autentikasi customer/admin, data customer, poin, redeem menu, katalog produk,
  lokasi outlet, promo, sinkronisasi data Runchise, dan activity log admin.

  ## Tech Stack

  - Node.js
  - Express.js
  - PostgreSQL
  - Prisma ORM
  - JWT Authentication
  - Nodemailer
  - Swagger UI
  - Vercel-ready deployment

  ## Fitur Utama

  - Login dan autentikasi user menggunakan JWT
  - Aktivasi akun customer
  - Manajemen data customer
  - Manajemen poin customer
  - Riwayat poin dan transaksi
  - Redeem/tukar poin menu outlet
  - Katalog produk dan menu redeem
  - Data lokasi outlet
  - Data promo
  - Sinkronisasi data dari Runchise
  - Activity log untuk aktivitas admin dan marketing
  - Dokumentasi API via Swagger

  ## Struktur Folder

  ```txt
  crisbro-backend/
  ├── prisma/
  │   └── schema.prisma
  ├── scripts/
  │   ├── createAdmin.js
  │   ├── prismaGenerate.js
  │   └── verifyRedeemMenuFlow.js
  ├── src/
  │   ├── controllers/
  │   ├── lib/
  │   ├── middlewares/
  │   ├── routes/
  │   ├── services/
  │   ├── index.js
  │   └── openapi.yaml
  ├── package.json
  └── README.md

  ## Environment Variables

  Buat file .env di root folder backend.

  DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
  DIRECT_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"

  JWT_SECRET="your-jwt-secret"

  RUNCHISE_API_KEY="your-runchise-api-key"
  RUNCHISE_PARENT_BRAND_ID="750"
  RUNCHISE_REDEEM_SUB_BRAND_ID="1041"

  PB1_RATE="0.1"
  DEFAULT_REWARD_THRESHOLD="100"

  MAIL_FROM="Crisbar <no-reply@yourdomain.com>"
  SMTP_HOST="smtp.example.com"
  SMTP_PORT="587"
  SMTP_USER="your-smtp-user"
  SMTP_PASS="your-smtp-password"
  SMTP_SECURE="false"

  FRONTEND_URL="http://localhost:5173"
  ACTIVATION_TOKEN_TTL_HOURS="24"

  CRON_SECRET="your-cron-secret"

  Jangan commit file .env ke repository.

  ## Instalasi

  npm install

  Generate Prisma Client:

  npm run build

  Jika menggunakan database baru, jalankan migration Prisma:

  npx prisma migrate deploy

  Untuk development database lokal:

  npx prisma migrate dev

  ## Menjalankan Server

  Development:

  npm run dev

  Default server berjalan di:

  http://localhost:5000

  Health check:

  GET /

  Response:

  {
    "message": "API Running"
  }

  ## Dokumentasi API

  Swagger UI tersedia di:

  GET /api/docs

  OpenAPI JSON tersedia di:

  GET /api/docs/openapi.json

  ## Endpoint Utama

  ### Auth

  /api/auth

  Digunakan untuk login, autentikasi, dan kebutuhan akses user.

  ### Customer

  /api/customers

  Digunakan untuk data customer, aktivasi akun, dan data profil customer.

  ### Points

  /api/points

  Digunakan untuk melihat poin customer dan riwayat poin.

  ### Rewards Catalog

  /api/rewards-catalog

  Digunakan untuk katalog reward berbasis poin.

  ### Redeem

  /api/redeem

  Digunakan untuk proses tukar poin/redeem menu.

  ### Redeem Menu Catalog

  /api/catalog/redeem-menu

  Digunakan untuk daftar kategori dan item menu redeem.

  ### Product Catalog

  /api/catalog/products

  Digunakan untuk katalog produk/menu.

  ### Locations

  /api/locations

  Digunakan untuk daftar lokasi outlet.

  ### Promos

  /api/promos

  Digunakan untuk daftar promo.

  ### Admin

  /api/admin

  Digunakan untuk dashboard admin, customer management, redeem menu management, dan activity log.

  ## Sinkronisasi Runchise

  Backend memiliki endpoint sinkronisasi untuk mengambil data dari Runchise.

  /admin/sync/customers
  /admin/sync/products
  /admin/sync/points
  /admin/sync/brands
  /admin/sync/locations
  /admin/sync/promos
  /admin/sync/sales-transactions

  Versi dengan prefix API juga tersedia:

  /api/admin/sync/customers
  /api/admin/sync/products
  /api/admin/sync/points
  /api/admin/sync/brands
  /api/admin/sync/locations
  /api/admin/sync/promos
  /api/admin/sync/sales-transactions

  Endpoint sync membutuhkan akses role admin/staff.

  ## Cron Sync

  Endpoint cron tersedia untuk menjalankan sinkronisasi otomatis. Setiap
  tahap punya endpoint, jadwal, dan mutex sendiri (lihat vercel.json) supaya
  timeout atau error pada satu tahap tidak menghanguskan tahap lain:

  GET  /api/cron/runchise-sync/locations
  POST /api/cron/runchise-sync/locations

  GET  /api/cron/runchise-sync/brands
  POST /api/cron/runchise-sync/brands

  GET  /api/cron/runchise-sync/products
  POST /api/cron/runchise-sync/products

  GET  /api/cron/runchise-sync/customers
  POST /api/cron/runchise-sync/customers
  (worker berbasis cursor; satu invocation memproses beberapa halaman lalu
  menyimpan progres, aman dipanggil berkali-kali per hari)

  GET  /api/cron/runchise-sync/sales-transactions
  POST /api/cron/runchise-sync/sales-transactions

  GET  /api/cron/runchise-sync/promos
  POST /api/cron/runchise-sync/promos

  GET  /api/cron/runchise-sync/points
  POST /api/cron/runchise-sync/points

  GET  /api/cron/runchise-sync/customer-timestamps-worker
  POST /api/cron/runchise-sync/customer-timestamps-worker

  /api/cron/runchise-sync/master sudah dihapus (mengembalikan 410 Gone).
  Endpoint itu dulu merangkai keenam tahap di atas berurutan dalam satu
  request, yang melebihi batas eksekusi function Vercel pada sinkronisasi
  harian.

  Di production, endpoint cron dilindungi menggunakan CRON_SECRET.

  Kirim secret melalui salah satu cara berikut:

  Authorization: Bearer your-cron-secret

  atau:

  x-cron-secret: your-cron-secret

  ## Activity Log Admin & Marketing

  Activity log disimpan di tabel AdminActivityLog.

  Data yang dicatat meliputi:

  - User yang melakukan aksi
  - Role user
  - Jenis aksi
  - Entity yang diubah
  - Data sebelum perubahan
  - Data setelah perubahan
  - Metadata tambahan
  - IP address
  - User agent
  - Waktu aktivitas

  Contoh aktivitas yang dicatat:

  - Membuat admin user
  - Mengubah admin user
  - Menghapus admin user
  - Membuat customer
  - Mengubah customer
  - Menghapus customer
  - Resend aktivasi customer
  - Retry sync customer ke Runchise
  - Membuat kategori redeem
  - Mengubah kategori redeem
  - Membuat item redeem
  - Mengubah item redeem
  - Menghapus item redeem

  ## Database

  Backend menggunakan PostgreSQL dengan Prisma ORM.

  Model utama:

  - User
  - Customer
  - CustomerPoint
  - PointHistory
  - RewardRedemption
  - RewardsCatalog
  - Brand
  - SubBrand
  - Location
  - MenuCategory
  - MenuItem
  - RedeemMenuCategory
  - RedeemMenuItem
  - Promo
  - CustomerSalesTransactionReport
  - AdminActivityLog

  Untuk membuka Prisma Studio:

  npx prisma studio

  ## Script

  npm run dev

  Menjalankan server development dengan nodemon.

  npm run build

  Generate Prisma Client.

  npm run create-admin

  Membuat user admin.

  npm run verify:redeem-menu

  Verifikasi flow redeem menu dengan konfirmasi write ke database.

  npm run cleanup:redeem-menu-test

  Membersihkan data test redeem menu.

  ## Deployment

  Backend sudah disiapkan untuk deployment, termasuk Vercel build hook.

  Script build production:

  npm run build

  Pastikan environment variable production sudah diisi:

  - DATABASE_URL
  - DIRECT_URL
  - JWT_SECRET
  - RUNCHISE_API_KEY
  - CRON_SECRET
  - SMTP config
  - Runchise config
  - Frontend URL

  ## Catatan Keamanan

  - Jangan commit .env
  - Gunakan JWT_SECRET yang kuat di production
  - Gunakan CRON_SECRET yang kuat untuk endpoint cron
  - Batasi akses endpoint admin hanya untuk role yang sesuai
  - Jangan menyimpan token, password, atau API key di repository
