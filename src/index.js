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
  syncCustomerPoints,
  syncCustomerPointsFromStaging,
} = require('./services/syncService');
const {
  startRunchiseSyncCron,
  runSyncLocationsJob,
  runSyncBrandsJob,
  runSyncProductsJob,
  runSyncSalesTransactionReportsJob,
  runSalesTransactionWorkerJob,
  runSyncPromosJob,
  runCustomerImportWorkerJob,
  runCustomerPointsSyncJob,
} = require('./jobs/runchiseSyncCron');
// M-3: Route sync manual admin memakai advisory lock Postgres yang sama dengan
// cron per tahap, agar trigger manual dan jadwal cron untuk tahap yang sama
// saling eksklusif alih-alih berjalan bersamaan tanpa guard.
const {
  withDistributedCronLock,
  RUNCHISE_CRON_LOCK_IDS,
} = require('./lib/distributedCronLock');
const { isCustomerSyncEnabled } = require('./lib/customerSyncToggle');
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
const {
  createSalesTransactionSyncJob,
  getSalesTransactionSyncJob,
  processSalesTransactionSyncJob,
} = require('./services/salesTransactionSyncService');
const {
  listSyncJobTelemetry,
} = require('./services/syncJobTelemetryService');

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

// M-3: Membungkus sync yang dipicu manual dari dashboard admin dengan advisory
// lock Postgres yang sama dengan cron per tahap (lockId dari RUNCHISE_CRON_LOCK_IDS),
// sehingga klik manual saat cron sedang berjalan (atau sebaliknya) tidak saling
// menumpuk beban maupun balapan pada baris yang sama — salah satu akan dilewati
// (skipped) alih-alih keduanya jalan bersamaan.
async function runAdminSyncWithLock(jobName, lockId, run) {
  return withDistributedCronLock({
    jobName: `admin-sync:${jobName}`,
    lockId,
    run,
  });
}

function respondSyncSkipped(res, jobLabel, result) {
  return res.status(409).json({
    message: `Sinkronisasi ${jobLabel} sedang berjalan (cron terjadwal atau proses lain); coba lagi sebentar.`,
    status: 'skipped',
    ...result,
  });
}

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
    // sync_enabled dipakai dashboard untuk berhenti menggerakkan worker dan
    // menampilkan status "dijeda" alih-alih "sedang berjalan".
    res.json({
      job: await getCustomerImportSyncJob(),
      sync_enabled: isCustomerSyncEnabled(),
    });
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
    res.json({
      job: await getCustomerTimestampSyncJob(),
      sync_enabled: isCustomerSyncEnabled(),
    });
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

// Sync products — memakai job cron yang sama (lock RUNCHISE_CRON_LOCK_IDS.products)
// agar trigger manual dari dashboard tidak balapan dengan cron terjadwal.
async function handleSyncProducts(req, res) {
  try {
    const result = await runSyncProductsJob();
    if (result?.skipped) return respondSyncSkipped(res, 'products', result);
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
    const result = await runAdminSyncWithLock(
      'points-manual',
      RUNCHISE_CRON_LOCK_IDS.points,
      () =>
        locationId
          ? syncCustomerPoints({ locationId })
          : syncCustomerPointsFromStaging(),
    );
    if (result?.skipped) return respondSyncSkipped(res, 'points', result);

    res.json({ message: 'Sync points selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

// Sync brands — memakai job cron yang sama (lock RUNCHISE_CRON_LOCK_IDS.brands).
async function handleSyncBrands(req, res) {
  try {
    const result = await runSyncBrandsJob();
    if (result?.skipped) return respondSyncSkipped(res, 'brands', result);
    res.json({ message: 'Sync brands selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

// Sync locations — memakai job cron yang sama (lock RUNCHISE_CRON_LOCK_IDS.locations).
async function handleSyncLocations(req, res) {
  try {
    const result = await runSyncLocationsJob();
    if (result?.skipped) return respondSyncSkipped(res, 'locations', result);
    res.json({ message: 'Sync locations selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

// Sync promos — memakai job cron yang sama (lock RUNCHISE_CRON_LOCK_IDS.promos).
async function handleSyncPromos(req, res) {
  try {
    const result = await runSyncPromosJob();
    if (result?.skipped) return respondSyncSkipped(res, 'promos', result);
    res.json({ message: 'Sync promos selesai', ...result });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

async function handleSyncSalesTransactions(req, res) {
  try {
    const result = await createSalesTransactionSyncJob({
      source: 'dashboard',
      locationId: req.query.location_id || null,
      startDate: req.query.start_date || req.query.from || null,
      endDate: req.query.end_date || req.query.to || null,
      status: req.query.status || null,
      paymentMethodIds: req.query.payment_method_ids || null,
    });
    res.status(result.created ? 202 : 200).json({
      message: result.created
        ? 'Job sync sales transactions dibuat'
        : 'Job sync sales transactions masih berjalan',
      ...result,
    });
  } catch (error) {
    respondWithServerError(res, error, 'index');
  }
}

async function handleSalesSyncStatus(req, res) {
  try {
    res.json({ job: await getSalesTransactionSyncJob() });
  } catch (error) {
    respondWithServerError(res, error, 'sales-sync-status');
  }
}

async function handleProcessSalesSync(req, res) {
  try {
    const result = await runAdminSyncWithLock(
      'sales-worker',
      RUNCHISE_CRON_LOCK_IDS.sales,
      () => processSalesTransactionSyncJob(),
    );
    if (result?.skipped) return respondSyncSkipped(res, 'sales transactions', result);
    res.json(result);
  } catch (error) {
    respondWithServerError(res, error, 'sales-sync-worker');
  }
}

async function handleSyncTelemetry(req, res) {
  try {
    const allowedStatuses = new Set([
      'queued',
      'running',
      'paused',
      'completed',
      'failed',
    ]);
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !allowedStatuses.has(status)) {
      return res.status(400).json({ message: 'status telemetry tidak valid' });
    }
    const rows = await listSyncJobTelemetry({
      limit: req.query.limit,
      jobName: req.query.job_name ? String(req.query.job_name).slice(0, 100) : null,
      status,
    });
    res.json({ items: rows });
  } catch (error) {
    respondWithServerError(res, error, 'sync-telemetry');
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
app.get('/admin/sync/sales-transactions/status', ...adminOnly, handleSalesSyncStatus);
app.post('/admin/sync/sales-transactions/process', ...adminOnly, handleProcessSalesSync);
app.get('/admin/sync/telemetry', ...adminOnly, handleSyncTelemetry);

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
app.get(
  '/api/admin/sync/sales-transactions/status',
  ...adminOnly,
  handleSalesSyncStatus,
);
app.post(
  '/api/admin/sync/sales-transactions/process',
  ...adminOnly,
  handleProcessSalesSync,
);
app.get('/api/admin/sync/telemetry', ...adminOnly, handleSyncTelemetry);

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
  '/api/cron/runchise-sync/sales-transactions-worker',
  requireCronSecret,
  createCronSyncHandler(
    'runchise-sales-transactions-worker',
    runSalesTransactionWorkerJob,
  ),
);
app.post(
  '/api/cron/runchise-sync/sales-transactions-worker',
  requireCronSecret,
  createCronSyncHandler(
    'runchise-sales-transactions-worker',
    runSalesTransactionWorkerJob,
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
  const telemetryRetentionDays = Math.min(
    Math.max(Number(process.env.SYNC_TELEMETRY_RETENTION_DAYS) || 90, 7),
    365,
  );
  const telemetryCutoff = new Date(
    now.getTime() - telemetryRetentionDays * 24 * 60 * 60 * 1000,
  );
  const [expiredSessions, rateLimitRows, telemetryRows] = await Promise.all([
    prisma.session.deleteMany({ where: { expires_at: { lte: now } } }),
    pruneRateLimitCounters(),
    prisma.$executeRaw`
      DELETE FROM "SyncJobTelemetry"
      WHERE "last_started_at" < ${telemetryCutoff}
    `,
  ]);

  return {
    expired_sessions_removed: expiredSessions.count,
    rate_limit_rows_removed: Number(rateLimitRows),
    telemetry_rows_removed: Number(telemetryRows),
    telemetry_retention_days: telemetryRetentionDays,
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

// Diekspos khusus untuk pengujian (lihat test/adminSyncManualLock.test.js) agar
// mutual exclusion antara trigger manual admin dan cron per tahap (M-3) dapat
// diverifikasi tanpa menembak HTTP/auth/DB sungguhan. Tidak memengaruhi perilaku
// produksi — hanya properti tambahan pada instance app yang sudah diekspor.
app.__testables = {
  handleSyncProducts,
  handleSyncBrands,
  handleSyncLocations,
  handleSyncPromos,
  handleSyncPoints,
  handleSyncSalesTransactions,
};

module.exports = app;
