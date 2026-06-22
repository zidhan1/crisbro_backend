const prisma = require('../lib/prisma');

function parsePositiveInt(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} harus berupa integer positif`);
  }

  return number;
}

function parseOptionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;

  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(`${fieldName} harus berupa boolean`);
}

function validationError(res, error) {
  return res.status(400).json({ message: error.message });
}

// GET /api/rewards-catalog
async function getAll(req, res) {
  try {
    const { brand_id, is_active } = req.query;

    const where = {};
    if (brand_id) where.brand_id = parsePositiveInt(brand_id, 'brand_id');
    if (is_active !== undefined) where.is_active = parseOptionalBoolean(is_active, 'is_active');

    const rewards = await prisma.rewardsCatalog.findMany({
      where,
      include: { brand: { select: { id: true, name: true } } },
      orderBy: { created_at: 'desc' },
    });

    res.json(rewards);
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    res.status(500).json({ error: error.message });
  }
}

// GET /api/rewards-catalog/:id
async function getOne(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');

    const reward = await prisma.rewardsCatalog.findUnique({
      where: { id },
      include: { brand: { select: { id: true, name: true } } },
    });

    if (!reward) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    res.json(reward);
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

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

    const parsedBrandId = parsePositiveInt(brand_id, 'brand_id');
    const parsedPointsRequired = parsePositiveInt(points_required, 'points_required');
    const parsedIsActive = parseOptionalBoolean(is_active, 'is_active') ?? true;

    const reward = await prisma.rewardsCatalog.create({
      data: {
        brand_id: parsedBrandId,
        name,
        description: description ?? null,
        points_required: parsedPointsRequired,
        image_url: image_url ?? null,
        is_active: parsedIsActive,
      },
    });

    res.status(201).json(reward);
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    if (error.code === 'P2003') {
      return res.status(400).json({ message: 'brand_id tidak valid' });
    }
    res.status(500).json({ error: error.message });
  }
}

// PUT /api/rewards-catalog/:id
async function update(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const { brand_id, name, description, points_required, image_url, is_active } = req.body;

    const existing = await prisma.rewardsCatalog.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    const reward = await prisma.rewardsCatalog.update({
      where: { id },
      data: {
        ...(brand_id !== undefined && { brand_id: parsePositiveInt(brand_id, 'brand_id') }),
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(points_required !== undefined && {
          points_required: parsePositiveInt(points_required, 'points_required'),
        }),
        ...(image_url !== undefined && { image_url }),
        ...(is_active !== undefined && {
          is_active: parseOptionalBoolean(is_active, 'is_active'),
        }),
      },
    });

    res.json(reward);
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    if (error.code === 'P2003') {
      return res.status(400).json({ message: 'brand_id tidak valid' });
    }
    res.status(500).json({ error: error.message });
  }
}

// DELETE /api/rewards-catalog/:id
async function remove(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');

    const existing = await prisma.rewardsCatalog.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    await prisma.rewardsCatalog.delete({ where: { id } });

    res.json({ message: 'Reward berhasil dihapus' });
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

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
