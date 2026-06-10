// ===================== IMPORT =====================
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const auth = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const { syncCustomers, syncProducts, syncCustomerPoints, syncBrands, syncLocations } = require('./services/syncService');
const rewardsCatalogRoutes = require('./routes/rewardsCatalogRoutes');

// ===================== APP =====================
const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', authRoutes);
app.use('/api/rewards-catalog', rewardsCatalogRoutes);

// ===================== TEST =====================
app.get('/', (req, res) => {
  res.json({ message: 'API Running' });
});

// ===================== REWARDS =====================
app.get('/rewards', async (req, res) => {
  try {
    // Diubah dari .reward menjadi .rewardsCatalog sesuai skema baru
    const rewards = await prisma.rewardsCatalog.findMany({
      where: { is_active: true } // Hanya tampilkan katalog yang aktif
    });
    res.json(rewards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== REDEEM (DUMMY UNTUK SEKARANG) =====================
app.post('/redeem/:id', auth, async (req, res) => {
  try {
    // Diubah dari .reward menjadi .rewardsCatalog sesuai skema baru
    const reward = await prisma.rewardsCatalog.findUnique({
      where: { id: Number(req.params.id) },
    });

    if (!reward) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    res.json({
      message: 'Reward ditemukan (logic points belum diaktifkan)',
      reward,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== SYNC RUNCHISE =====================
app.post('/admin/sync/customers', auth, async (req, res) => {
  try {
    const locationId = req.query.location_id || 1;
    const result = await syncCustomers(locationId);
    res.json({ message: 'Sync customers selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/sync/products', auth, async (req, res) => {
  try {
    const result = await syncProducts();
    res.json({ message: 'Sync products selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/sync/points', auth, async (req, res) => {
  try {
    const locationId = req.query.location_id || 1;
    const result = await syncCustomerPoints(locationId);
    res.json({ message: 'Sync points selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/sync/brands', auth, async (req, res) => {
  try {
    const result = await syncBrands();
    res.json({ message: 'Sync brands selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/sync/locations', auth, async (req, res) => {
  try {
    const result = await syncLocations();
    res.json({ message: 'Sync locations selesai', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== START SERVER =====================
app.listen(5000, () => {
  console.log('Server running on port 5000');
});