// Load environment variables (.env)
require('dotenv').config({ quiet: true });

// Core dependencies
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { openApiSpec, renderSwaggerHtml } = require('./docs/swagger');
const {
  globalLimiter,
  pruneRateLimitCounters,
} = require('./lib/rateLimit');

// Prisma ORM (database client)
const prisma = require('./lib/prisma');

// Middleware
const auth = require('./middleware/auth');
const requireRole = require('./middleware/requireRole');

// Routes (modular API)
const customerRoutes = require('./routes/customerRoutes');
const authRoutes = require('./routes/authRoutes');
const rewardsCatalogRoutes = require('./routes/rewardsCatalogRoutes');
const redemptionRoutes = require('./routes/redemptionRoutes');
const locationRoutes = require('./routes/locationRoutes');
const productCatalogRoutes = require('./routes/productCatalogRoutes');
const redeemMenuRoutes = require('./routes/redeemMenuRoutes');
const promoRoutes = require('./routes/promoRoutes');
const adminLoyaltyRoutes = require('./routes/adminLoyaltyRoutes');
const pointRoutes = require('./routes/pointRoutes');

// Sync services (ETL dari Runchise → DB lokal)
const {
  syncProducts,
  syncCustomerPoints,
  syncCustomerPointsFromStaging,
  syncSalesTransactionReports,
  syncBrands,
  syncLocations,
  syncPromos,
} = require('./services/syncService');
const {
  startRunchiseSyncCron,
  runRunchiseMasterSyncJob,
  runCustomerSyncJob,
  runCustomerPointsSyncJob,
} = require('./jobs/runchiseSyncCron');
const {
  createCustomerTimestampSyncJob,
  getCustomerTimestampSyncJob,
  processCustomerTimestampSyncJob,
} = require('./services/customerTimestampSyncService');
const {
  createCustomerImportSyncJob,
  getCustomerImportSyncJob,
  processCustomerImportSyncJob,
} = require('./services/customerImportSyncService');

// ===================== APP SETUP =====================
const app = express();

// Vercel menaruh satu proxy di depan function. Tanpa ini req.ip berisi alamat
// proxy, sehingga seluruh pengunjung terhitung sebagai satu IP dan rate limit
// jadi salah sasaran. Angka 1 dipakai, bukan true, karena mempercayai seluruh
// rantai X-Forwarded-For membuat IP gampang dipalsukan.
app.set('trust proxy', 1);

// Header keamanan dasar. Content-Security-Policy dimatikan karena halaman
// Swagger yang dilayani backend memakai skrip inline; API JSON tidak
// membutuhkannya.
app.use(helmet({ contentSecurityPolicy: false }));

// Hanya origin yang dikenal yang boleh memanggil API dari browser. Sebelumnya
// cors() tanpa argumen mengizinkan semua origin.
//
// Permintaan tanpa header Origin sengaja diizinkan: itu bukan permintaan lintas
// origin dari browser, melainkan cron Vercel, health check, dan curl.
const allowedOrigins = new Set(
  [
    process.env.FRONTEND_URL,
    ...String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim()),
  ]
    .filter(Boolean)
    .map((origin) => origin.replace(/\/$/, '')),
);

const isProduction = process.env.NODE_ENV === 'production';

// Di luar produksi, seluruh port localhost diizinkan. Menuliskan daftar port
// tetap terbukti rapuh: dev server proyek ini berjalan di 8080, sementara
// tooling lain memakai 5173, 3000, atau port acak.
//
// Pengecekan memakai URL parser, bukan pencocokan awalan string, supaya
// domain seperti http://localhost.situs-penyerang.com tidak ikut lolos.
function isLocalhostOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin) {
  if (allowedOrigins.has(origin.replace(/\/$/, ''))) return true;

  return !isProduction && isLocalhostOrigin(origin);
}

// Origin asing ditolak di depan dengan 403 yang bersih. Melempar Error dari
// dalam callback cors membuat Express membalas 500 beserta stack trace, yang
// membingungkan sekaligus membocorkan detail internal.
app.use((req, res, next) => {
  const origin = req.get('origin');

  if (origin && !isAllowedOrigin(origin)) {
    return res
      .status(403)
      .json({ message: 'Origin tidak diizinkan oleh kebijakan CORS' });
  }

  return next();
});

// Sampai di sini origin sudah pasti dikenal, jadi aman untuk dipantulkan.
app.use(cors({ origin: true, credentials: true }));

// Batas ukuran body. Default express.json() adalah 100kb, ditegaskan di sini
// supaya tidak berubah diam-diam mengikuti versi express.
app.use(express.json({ limit: '100kb' }));

// Batas laju umum untuk seluruh API.
app.use(globalLimiter);
app.get('/api/docs/openapi.json', (req, res) => res.json(openApiSpec));
app.get(['/api/docs', '/api/docs/'], (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(renderSwaggerHtml());
});
app.use('/api', customerRoutes);
app.use('/api', authRoutes);
app.use('/api/rewards-catalog', rewardsCatalogRoutes);
app.use('/api/redeem', redemptionRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/catalog/redeem-menu', redeemMenuRoutes);
app.use('/api/catalog/products', productCatalogRoutes);
app.use('/api/promos', promoRoutes);
app.use('/api/points', pointRoutes);
app.use('/api/admin', adminLoyaltyRoutes);

// ===================== HEALTH CHECK =====================
app.get('/', (req, res) => {
  res.json({ message: 'API Running' });
});

// ===================== REWARDS (LEGACY / SIMPLE ENDPOINT) =====================

// Ambil reward aktif (langsung dari DB)
app.get('/rewards', async (req, res) => {
  try {
    // Diubah dari .reward menjadi .rewardsCatalog sesuai skema baru
    const rewards = await prisma.rewardsCatalog.findMany({
      where: { is_active: true }, // Hanya tampilkan katalog yang aktif
    });
    res.json(rewards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== POINTS USER =====================

// GET /api/my-points — ambil poin customer yang login
app.get('/api/my-points', auth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
      include: { customer_point: true },
    });
    if (!customer)
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    res.json(customer.customer_point ?? { available_point: 0, total_point: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== REDEEM LEGACY ENDPOINT =====================

// Endpoint lama dipertahankan hanya untuk mencegah sukses palsu.
// Gunakan POST /api/redeem/:rewardId.
app.post('/redeem/:id', auth, (req, res) => {
  return res.status(410).json({
    message:
      'Endpoint ini sudah tidak digunakan. Gunakan POST /api/redeem/:rewardId',
  });
});

// ===================== SYNC HANDLERS (WRAPPER API) =====================

// Sync customers dari Runchise → DB lokal.
//
// Impor penuh mencakup 29 outlet x 100 halaman API, jadi tidak muat dalam satu
// request serverless. Endpoint ini hanya membuat job; kemajuannya dilaporkan
// lewat /sync/customers/status dan dieksekusi bertahap oleh
// /sync/customers/process.
async function handleSyncCustomers(req, res) {
  try {
    const result = await createCustomerImportSyncJob();
    res.status(result.created ? 202 : 200).json({
      message: result.created
        ? 'Job sinkronisasi customer Runchise dimulai'
        : 'Job sinkronisasi customer Runchise sudah berjalan',
      ...result,
    });
  } catch (error) {
    console.error('Gagal membuat job impor customer Runchise:', error);
    res.status(500).json({
      message: 'Gagal memulai sinkronisasi customer Runchise',
      error: error.message,
    });
  }
}

async function handleCustomerSyncStatus(req, res) {
  try {
    res.json({ job: await getCustomerImportSyncJob() });
  } catch (error) {
    res.status(500).json({
      message: 'Gagal membaca status sinkronisasi customer',
      error: error.message,
    });
  }
}

async function handleProcessCustomerSync(req, res) {
  try {
    res.json(await processCustomerImportSyncJob());
  } catch (error) {
    console.error('Worker impor customer Runchise gagal:', error);
    res.status(500).json({
      message: 'Worker sinkronisasi customer gagal',
      error: error.message,
    });
  }
}

async function handleStartCustomerTimestampSync(req, res) {
  try {
    const result = await createCustomerTimestampSyncJob();
    res.status(result.created ? 202 : 200).json({
      message: result.created
        ? 'Job sinkronisasi tanggal Runchise dimulai'
        : 'Job sinkronisasi tanggal Runchise sudah berjalan',
      ...result,
    });
  } catch (error) {
    console.error('Gagal membuat job timestamp customer Runchise:', error);
    res.status(500).json({
      message: 'Gagal memulai sinkronisasi tanggal customer Runchise',
      error: error.message,
    });
  }
}

async function handleCustomerTimestampSyncStatus(req, res) {
  try {
    res.json({ job: await getCustomerTimestampSyncJob() });
  } catch (error) {
    res
      .status(500)
      .json({
        message: 'Gagal membaca status sinkronisasi',
        error: error.message,
      });
  }
}

async function handleProcessCustomerTimestampSync(req, res) {
  try {
    res.json(await processCustomerTimestampSyncJob());
  } catch (error) {
    console.error('Worker timestamp customer Runchise gagal:', error);
    res.status(500).json({
      message: 'Worker sinkronisasi tanggal customer gagal',
      error: error.message,
    });
  }
}

// Sync products
async function handleSyncProducts(req, res) {
  try {
    const result = await syncProducts();
    res.json({ message: 'Sync products selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Sync points
//
// Tanpa location_id, poin diturunkan dari tabel staging: mencakup ke-29 outlet
// dan selesai dalam satu query, sehingga tetap aman di batas waktu serverless.
// Dengan location_id, satu outlet disegarkan langsung dari API Runchise.
// Refresh penuh semua outlet dari API dijalankan lewat `npm run sync:points`.
async function handleSyncPoints(req, res) {
  try {
    const rawLocationId = Number(req.query.location_id);
    const locationId =
      Number.isInteger(rawLocationId) && rawLocationId > 0
        ? rawLocationId
        : null;
    const result = locationId
      ? await syncCustomerPoints({ locationId })
      : await syncCustomerPointsFromStaging();

    res.json({ message: 'Sync points selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Sync brands
async function handleSyncBrands(req, res) {
  try {
    const result = await syncBrands();
    res.json({ message: 'Sync brands selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Sync locations
async function handleSyncLocations(req, res) {
  try {
    const result = await syncLocations();
    res.json({ message: 'Sync locations selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function handleSyncPromos(req, res) {
  try {
    const result = await syncPromos();
    res.json({ message: 'Sync promos selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function handleSyncSalesTransactions(req, res) {
  try {
    // Tanpa fallback ke 1: tidak ada outlet Crisbar dengan ID itu di Runchise.
    const locationId =
      req.query.location_id || process.env.RUNCHISE_SYNC_LOCATION_ID || null;
    const result = await syncSalesTransactionReports(locationId, {
      start_date: req.query.start_date,
      end_date: req.query.end_date,
      status: req.query.status,
      payment_method_ids: req.query.payment_method_ids,
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ message: 'Sync sales transactions selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ===================== ADMIN MIDDLEWARE =====================

// Middleware gabungan: login + role check
const adminOnly = [auth, requireRole('admin', 'staff')];

// ===================== ADMIN SYNC ROUTES =====================

// Endpoint sync (tanpa prefix /api)
app.post('/admin/sync/customers', ...adminOnly, handleSyncCustomers);
app.get(
  '/admin/sync/customers/status',
  ...adminOnly,
  handleCustomerSyncStatus,
);
app.post(
  '/admin/sync/customers/process',
  ...adminOnly,
  handleProcessCustomerSync,
);
app.post(
  '/admin/sync/customer-timestamps',
  ...adminOnly,
  handleStartCustomerTimestampSync,
);
app.get(
  '/admin/sync/customer-timestamps/status',
  ...adminOnly,
  handleCustomerTimestampSyncStatus,
);
app.post(
  '/admin/sync/customer-timestamps/process',
  ...adminOnly,
  handleProcessCustomerTimestampSync,
);
app.post('/admin/sync/products', ...adminOnly, handleSyncProducts);
app.post('/admin/sync/points', ...adminOnly, handleSyncPoints);
app.post('/admin/sync/brands', ...adminOnly, handleSyncBrands);
app.post('/admin/sync/locations', ...adminOnly, handleSyncLocations);
app.post('/admin/sync/promos', ...adminOnly, handleSyncPromos);
app.post(
  '/admin/sync/sales-transactions',
  ...adminOnly,
  handleSyncSalesTransactions,
);

// Endpoint sync (dengan prefix /api)
app.post('/api/admin/sync/customers', ...adminOnly, handleSyncCustomers);
app.get(
  '/api/admin/sync/customers/status',
  ...adminOnly,
  handleCustomerSyncStatus,
);
app.post(
  '/api/admin/sync/customers/process',
  ...adminOnly,
  handleProcessCustomerSync,
);
app.post(
  '/api/admin/sync/customer-timestamps',
  ...adminOnly,
  handleStartCustomerTimestampSync,
);
app.get(
  '/api/admin/sync/customer-timestamps/status',
  ...adminOnly,
  handleCustomerTimestampSyncStatus,
);
app.post(
  '/api/admin/sync/customer-timestamps/process',
  ...adminOnly,
  handleProcessCustomerTimestampSync,
);
app.post('/api/admin/sync/products', ...adminOnly, handleSyncProducts);
app.post('/api/admin/sync/points', ...adminOnly, handleSyncPoints);
app.post('/api/admin/sync/brands', ...adminOnly, handleSyncBrands);
app.post('/api/admin/sync/locations', ...adminOnly, handleSyncLocations);
app.post('/api/admin/sync/promos', ...adminOnly, handleSyncPromos);
app.post(
  '/api/admin/sync/sales-transactions',
  ...adminOnly,
  handleSyncSalesTransactions,
);

// ===================== VERCEL CRON SYNC ROUTES =====================

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function requireCronSecret(req, res, next) {
  const secret =
    process.env.CRON_SECRET || process.env.RUNCHISE_SYNC_CRON_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        message: 'CRON_SECRET belum dikonfigurasi',
      });
    }

    return next();
  }

  const authorization = req.get('authorization') || '';
  const bearerToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const headerToken = req.get('x-cron-secret') || '';

  if (
    safeStringEqual(bearerToken, secret) ||
    safeStringEqual(headerToken, secret)
  ) {
    return next();
  }

  return res.status(401).json({ message: 'Unauthorized cron request' });
}

function createCronSyncHandler(jobName, job) {
  return async (req, res) => {
    const startedAt = new Date();

    try {
      const result = await job();

      res.json({
        message: `Cron sync ${jobName} selesai`,
        job: jobName,
        started_at: startedAt,
        finished_at: new Date(),
        result,
      });
    } catch (error) {
      console.error(`[cron:${jobName}] failed:`, error);
      res.status(500).json({
        message: `Cron sync ${jobName} gagal`,
        job: jobName,
        error: error.message,
      });
    }
  };
}

app.get(
  '/api/cron/runchise-sync/master',
  requireCronSecret,
  createCronSyncHandler('runchise-master', runRunchiseMasterSyncJob),
);
app.post(
  '/api/cron/runchise-sync/master',
  requireCronSecret,
  createCronSyncHandler('runchise-master', runRunchiseMasterSyncJob),
);
app.get(
  '/api/cron/runchise-sync/customer-timestamps-worker',
  requireCronSecret,
  createCronSyncHandler('runchise-customer-timestamps', () =>
    processCustomerTimestampSyncJob({ maxPages: 5 }),
  ),
);
app.post(
  '/api/cron/runchise-sync/customer-timestamps-worker',
  requireCronSecret,
  createCronSyncHandler('runchise-customer-timestamps', () =>
    processCustomerTimestampSyncJob({ maxPages: 5 }),
  ),
);
app.get(
  '/api/cron/runchise-sync/customers',
  requireCronSecret,
  createCronSyncHandler('runchise-customers', runCustomerSyncJob),
);
app.post(
  '/api/cron/runchise-sync/customers',
  requireCronSecret,
  createCronSyncHandler('runchise-customers', runCustomerSyncJob),
);
app.get(
  '/api/cron/runchise-sync/points',
  requireCronSecret,
  createCronSyncHandler('runchise-points', runCustomerPointsSyncJob),
);
app.post(
  '/api/cron/runchise-sync/points',
  requireCronSecret,
  createCronSyncHandler('runchise-points', runCustomerPointsSyncJob),
);

// Pembersihan berkala. Sesi yang sudah kedaluwarsa dan hitungan rate limit yang
// jendelanya lewat tidak pernah dihapus siapa pun, sehingga kedua tabel terus
// menumpuk. Sesi kedaluwarsa memang sudah ditolak middleware auth, tetapi
// menyimpan token yang tidak terpakai tanpa batas waktu tidak ada gunanya.
async function runMaintenanceJob() {
  const now = new Date();
  const [expiredSessions, rateLimitRows] = await Promise.all([
    prisma.session.deleteMany({ where: { expires_at: { lte: now } } }),
    pruneRateLimitCounters(),
  ]);

  return {
    expired_sessions_removed: expiredSessions.count,
    rate_limit_rows_removed: Number(rateLimitRows),
  };
}

app.get(
  '/api/cron/maintenance',
  requireCronSecret,
  createCronSyncHandler('maintenance', runMaintenanceJob),
);
app.post(
  '/api/cron/maintenance',
  requireCronSecret,
  createCronSyncHandler('maintenance', runMaintenanceJob),
);

// ===================== START SERVER =====================
if (require.main === module) {
  const port = process.env.PORT || 5000;

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startRunchiseSyncCron();
  });
}

module.exports = app;
