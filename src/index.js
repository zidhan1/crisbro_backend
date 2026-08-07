// Load environment variables (.env)
require('dotenv').config({ quiet: true });

// Core dependencies
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { openApiSpec, renderSwaggerHtml } = require('./docs/swagger');
const { safeStringEqual } = require('./lib/safeCompare');
const { globalLimiter, pruneRateLimitCounters } = require('./lib/rateLimit');
const { createCorsPolicy } = require('./lib/corsPolicy');

// Prisma ORM (database client)
const prisma = require('./lib/prisma');

// Middleware
const auth = require('./middleware/auth');
const requireRole = require('./middleware/requireRole');
const requireDocsAccess = require('./middleware/docsAccess');
const docsContentSecurityPolicy = require('./middleware/docsCsp');

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
const { respondWithServerError } = require('./lib/serverError');

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
  runSyncLocationsJob,
  runSyncBrandsJob,
  runSyncProductsJob,
  runSyncSalesTransactionReportsJob,
  runSyncPromosJob,
  runCustomerImportWorkerJob,
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

// Mengatur `trust proxy` ke 1 agar rate limit menggunakan IP asli pengguna secara akurat tanpa membuka risiko pemalsuan IP.
app.set('trust proxy', 1);

// L-2: Menerapkan Content Security Policy (CSP) secara global dengan kebijakan khusus untuk Swagger agar tetap aman tanpa mengganggu fungsionalitas dokumentasi API.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);

// Membatasi akses CORS hanya untuk origin yang tepercaya, sambil tetap mengizinkan permintaan tanpa header Origin untuk cron, health check, dan akses non-browser.
const corsPolicy = createCorsPolicy();

// Menolak origin yang tidak diizinkan dengan respons 403 agar lebih aman, konsisten, dan tidak membocorkan detail internal server.
app.use(corsPolicy.guard);

// Sampai di sini origin sudah pasti dikenal, jadi aman untuk dipantulkan.
app.use(cors(corsPolicy.corsOptions));

// Menetapkan batas ukuran request body secara eksplisit agar tetap konsisten dan tidak berubah mengikuti pembaruan Express.
app.use(express.json({ limit: '100kb' }));

// Batas laju umum untuk seluruh API.
app.use(globalLimiter);
// M-13: Melindungi akses Swagger UI dan OpenAPI dengan pembatasan akses agar tidak terekspos di lingkungan production.
app.get('/api/docs/openapi.json', requireDocsAccess, (req, res) =>
  res.set('Cache-Control', 'no-store').json(openApiSpec),
);
app.get(
  ['/api/docs', '/api/docs/'],
  docsContentSecurityPolicy,
  requireDocsAccess,
  (req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(renderSwaggerHtml(res.locals.cspNonce));
  },
);
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
    respondWithServerError(res, error, 'index');
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
    respondWithServerError(res, error, 'index');
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

// Sinkronisasi customer dari Runchise dijalankan bertahap melalui sistem job agar aman diproses di lingkungan serverless.
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
    respondWithServerError(
      res,
      error,
      'Gagal memulai sinkronisasi customer Runchise',
    );
  }
}

async function handleCustomerSyncStatus(req, res) {
  try {
    res.json({ job: await getCustomerImportSyncJob() });
  } catch (error) {
    respondWithServerError(
      res,
      error,
      'Gagal membaca status sinkronisasi customer',
    );
  }
}

async function handleProcessCustomerSync(req, res) {
  try {
    res.json(await processCustomerImportSyncJob());
  } catch (error) {
    console.error('Worker impor customer Runchise gagal:', error);
    respondWithServerError(res, error, 'Worker sinkronisasi customer gagal');
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
    respondWithServerError(
      res,
      error,
      'Gagal memulai sinkronisasi tanggal customer Runchise',
    );
  }
}

async function handleCustomerTimestampSyncStatus(req, res) {
  try {
    res.json({ job: await getCustomerTimestampSyncJob() });
  } catch (error) {
    respondWithServerError(res, error, 'Gagal membaca status sinkronisasi');
  }
}

async function handleProcessCustomerTimestampSync(req, res) {
  try {
    res.json(await processCustomerTimestampSyncJob());
  } catch (error) {
    console.error('Worker timestamp customer Runchise gagal:', error);
    respondWithServerError(
      res,
      error,
      'Worker sinkronisasi tanggal customer gagal',
    );
  }
}

// Sync products
async function handleSyncProducts(req, res) {
  try {
    const result = await syncProducts();
    res.json({ message: 'Sync products selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

// Sinkronisasi poin menggunakan tabel staging untuk seluruh outlet atau API Runchise per outlet agar tetap aman di lingkungan serverless.
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
    respondWithServerError(res, error, 'index');
  }
}

// Sync brands
async function handleSyncBrands(req, res) {
  try {
    const result = await syncBrands();
    res.json({ message: 'Sync brands selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

// Sync locations
async function handleSyncLocations(req, res) {
  try {
    const result = await syncLocations();
    res.json({ message: 'Sync locations selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

async function handleSyncPromos(req, res) {
  try {
    const result = await syncPromos();
    res.json({ message: 'Sync promos selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
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
    respondWithServerError(res, error, 'index');
  }
}

// ===================== ADMIN MIDDLEWARE =====================

// Middleware login dan pemeriksaan role disederhanakan dengan menghapus role `staff` yang tidak digunakan agar sesuai dengan data di database.
const adminOnly = [auth, requireRole('admin')];

// Akses sinkronisasi customer diperluas untuk marketing sesuai kewenangannya, sementara sinkronisasi master data lainnya tetap dibatasi untuk admin.
const adminOrMarketing = [auth, requireRole('admin', 'marketing')];

// ===================== ADMIN SYNC ROUTES =====================

// Endpoint sync (tanpa prefix /api)
app.post('/admin/sync/customers', ...adminOrMarketing, handleSyncCustomers);
app.get(
  '/admin/sync/customers/status',
  ...adminOrMarketing,
  handleCustomerSyncStatus,
);
app.post(
  '/admin/sync/customers/process',
  ...adminOrMarketing,
  handleProcessCustomerSync,
);
app.post(
  '/admin/sync/customer-timestamps',
  ...adminOrMarketing,
  handleStartCustomerTimestampSync,
);
app.get(
  '/admin/sync/customer-timestamps/status',
  ...adminOrMarketing,
  handleCustomerTimestampSyncStatus,
);
app.post(
  '/admin/sync/customer-timestamps/process',
  ...adminOrMarketing,
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
app.post('/api/admin/sync/customers', ...adminOrMarketing, handleSyncCustomers);
app.get(
  '/api/admin/sync/customers/status',
  ...adminOrMarketing,
  handleCustomerSyncStatus,
);
app.post(
  '/api/admin/sync/customers/process',
  ...adminOrMarketing,
  handleProcessCustomerSync,
);
app.post(
  '/api/admin/sync/customer-timestamps',
  ...adminOrMarketing,
  handleStartCustomerTimestampSync,
);
app.get(
  '/api/admin/sync/customer-timestamps/status',
  ...adminOrMarketing,
  handleCustomerTimestampSyncStatus,
);
app.post(
  '/api/admin/sync/customer-timestamps/process',
  ...adminOrMarketing,
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
      const status = result?.skipped ? 'skipped' : 'completed';

      res.json({
        message: result?.skipped
          ? `Cron sync ${jobName} dilewati karena job masih aktif`
          : `Cron sync ${jobName} selesai`,
        status,
        job: jobName,
        started_at: startedAt,
        finished_at: new Date(),
        result,
      });
    } catch (error) {
      // Endpoint cron menyembunyikan detail error pada respons dan mencatat penyebab aslinya di log server agar tetap aman serta konsisten.
      respondWithServerError(res, error, `cron:${jobName}`);
    }
  };
}

// C-1: Master sync dipecah menjadi cron terpisah per tahap dengan worker berbasis cursor untuk sinkronisasi customer agar setiap proses berjalan independen dan terhindar dari timeout serverless.
app.all('/api/cron/runchise-sync/master', requireCronSecret, (req, res) => {
  res.status(410).json({
    message:
      'Endpoint ini sudah dipecah menjadi cron per tahap untuk mencegah timeout serverless. ' +
      'Gunakan /api/cron/runchise-sync/locations, /brands, /products, /customers, ' +
      '/sales-transactions, /promos, dan /points secara terpisah.',
  });
});
app.get(
  '/api/cron/runchise-sync/locations',
  requireCronSecret,
  createCronSyncHandler('runchise-locations', runSyncLocationsJob),
);
app.post(
  '/api/cron/runchise-sync/locations',
  requireCronSecret,
  createCronSyncHandler('runchise-locations', runSyncLocationsJob),
);
app.get(
  '/api/cron/runchise-sync/brands',
  requireCronSecret,
  createCronSyncHandler('runchise-brands', runSyncBrandsJob),
);
app.post(
  '/api/cron/runchise-sync/brands',
  requireCronSecret,
  createCronSyncHandler('runchise-brands', runSyncBrandsJob),
);
app.get(
  '/api/cron/runchise-sync/products',
  requireCronSecret,
  createCronSyncHandler('runchise-products', runSyncProductsJob),
);
app.post(
  '/api/cron/runchise-sync/products',
  requireCronSecret,
  createCronSyncHandler('runchise-products', runSyncProductsJob),
);
app.get(
  '/api/cron/runchise-sync/sales-transactions',
  requireCronSecret,
  createCronSyncHandler(
    'runchise-sales-transactions',
    runSyncSalesTransactionReportsJob,
  ),
);
app.post(
  '/api/cron/runchise-sync/sales-transactions',
  requireCronSecret,
  createCronSyncHandler(
    'runchise-sales-transactions',
    runSyncSalesTransactionReportsJob,
  ),
);
app.get(
  '/api/cron/runchise-sync/promos',
  requireCronSecret,
  createCronSyncHandler('runchise-promos', runSyncPromosJob),
);
app.post(
  '/api/cron/runchise-sync/promos',
  requireCronSecret,
  createCronSyncHandler('runchise-promos', runSyncPromosJob),
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
// Worker berbasis cursor memproses data secara bertahap dengan menyimpan progres sehingga setiap eksekusi dapat melanjutkan dari checkpoint terakhir dan aman dijalankan berulang oleh scheduler.
app.get(
  '/api/cron/runchise-sync/customers',
  requireCronSecret,
  createCronSyncHandler('runchise-customers', runCustomerImportWorkerJob),
);
app.post(
  '/api/cron/runchise-sync/customers',
  requireCronSecret,
  createCronSyncHandler('runchise-customers', runCustomerImportWorkerJob),
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

// Pembersihan berkala menghapus sesi kedaluwarsa dan data rate limit yang sudah tidak berlaku agar penyimpanan tetap efisien.
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
