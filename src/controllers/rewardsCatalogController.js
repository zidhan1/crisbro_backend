const prisma = require('../lib/prisma');

// GET /api/rewards-catalog
async function getAll(req, res) {
  try {
    const { brand_id, is_active } = req.query;

    const where = {};
    if (brand_id) where.brand_id = Number(brand_id);
    if (is_active !== undefined) where.is_active = is_active === 'true';

    const rewards = await prisma.rewardsCatalog.findMany({
      where,
      include: { brand: { select: { id: true, name: true } } },
      orderBy: { created_at: 'desc' },
    });

    res.json(rewards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// GET /api/rewards-catalog/:id
async function getOne(req, res) {
  try {
    const reward = await prisma.rewardsCatalog.findUnique({
      where: { id: Number(req.params.id) },
      include: { brand: { select: { id: true, name: true } } },
    });

    if (!reward) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    res.json(reward);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// POST /api/rewards-catalog
async function create(req, res) {
  try {
    const { brand_id, name, description, points_required, image_url, is_active } = req.body;

    if (!brand_id || !name || points_required === undefined) {
      return res.status(400).json({ message: 'brand_id, name, dan points_required wajib diisi' });
    }

    const reward = await prisma.rewardsCatalog.create({
      data: {
        brand_id: Number(brand_id),
        name,
        description: description ?? null,
        points_required: Number(points_required),
        image_url: image_url ?? null,
        is_active: is_active ?? true,
      },
    });

    res.status(201).json(reward);
  } catch (error) {
    if (error.code === 'P2003') {
      return res.status(400).json({ message: 'brand_id tidak valid' });
    }
    res.status(500).json({ error: error.message });
  }
}

// PUT /api/rewards-catalog/:id
async function update(req, res) {
  try {
    const id = Number(req.params.id);
    const { brand_id, name, description, points_required, image_url, is_active } = req.body;

    const existing = await prisma.rewardsCatalog.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    const reward = await prisma.rewardsCatalog.update({
      where: { id },
      data: {
        ...(brand_id !== undefined && { brand_id: Number(brand_id) }),
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(points_required !== undefined && { points_required: Number(points_required) }),
        ...(image_url !== undefined && { image_url }),
        ...(is_active !== undefined && { is_active }),
      },
    });

    res.json(reward);
  } catch (error) {
    if (error.code === 'P2003') {
      return res.status(400).json({ message: 'brand_id tidak valid' });
    }
    res.status(500).json({ error: error.message });
  }
}

// DELETE /api/rewards-catalog/:id
async function remove(req, res) {
  try {
    const id = Number(req.params.id);

    const existing = await prisma.rewardsCatalog.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    await prisma.rewardsCatalog.delete({ where: { id } });

    res.json({ message: 'Reward berhasil dihapus' });
  } catch (error) {
    // P2003 = masih ada RewardRedemption yang referensi reward ini
    if (error.code === 'P2003') {
      return res.status(409).json({
        message: 'Reward tidak bisa dihapus karena masih ada data redemption terkait',
      });
    }
    res.status(500).json({ error: error.message });
  }
}

module.exports = { getAll, getOne, create, update, remove };