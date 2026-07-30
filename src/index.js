// Load environment variables (.env)
require('dotenv').config({ quiet: true });

// Core dependencies
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { openApiSpec, renderSwaggerHtml } = require('./docs/swagger');

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
  syncCustomers,
  syncProducts,
  syncCrisbroRedeemMenu,
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

// ===================== APP SETUP =====================
const app = express();
app.use(cors());
app.use(express.json());
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

// Sync customers dari Runchise → DB lokal
async function handleSyncCustomers(req, res) {
  try {
    // Tanpa fallback ke 1: outlet itu tidak ada di Runchise, dan memakainya
    // membuat customer tanpa owner_location dipetakan ke outlet palsu.
    const locationId = req.query.location_id || null;
    const result = await syncCustomers(locationId);
    res.json({ message: 'Sync customers selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Endpoint kompatibilitas untuk frontend yang memeriksa background customer job.
// Sync customer saat ini masih dijalankan langsung oleh POST /sync/customers,
// sehingga tidak ada job persisten yang perlu dilaporkan atau diproses terpisah.
async function handleCustomerSyncStatus(req, res) {
  res.json({ job: null });
}

async function handleProcessCustomerSync(req, res) {
  res.json({ status: 'idle', job: null });
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

// Sync redeem menu
async function handleSyncRedeemMenu(req, res) {
  try {
    const result = await syncCrisbroRedeemMenu();
    res.json({ message: 'Sync menu redeem Crisbro selesai', ...result });
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
app.post('/admin/sync/redeem-menu', ...adminOnly, handleSyncRedeemMenu);
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
app.post('/api/admin/sync/redeem-menu', ...adminOnly, handleSyncRedeemMenu);
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

// ===================== START SERVER =====================
if (require.main === module) {
  const port = process.env.PORT || 5000;

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startRunchiseSyncCron();
  });
}

module.exports = app;
