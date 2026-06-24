const prisma = require('../lib/prisma');

// Memvalidasi agar nilai berupa bilangan bulat positif
function parsePositiveInt(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} harus berupa integer positif`);
  }

  return number;
}

// Memvalidasi dan mengubah nilai menjadi boolean
function parseOptionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;

  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(`${fieldName} harus berupa boolean`);
}

// Mengirim response error validasi
function validationError(res, error) {
  return res.status(400).json({ message: error.message });
}

// ===================== GET ALL REWARDS =====================

// Mengambil seluruh data reward dengan filter opsional
// GET /api/rewards-catalog
async function getAll(req, res) {
  try {
    // Mengambil parameter filter dari query
    const { brand_id, is_active } = req.query;

    // Menyusun filter pencarian
    const where = {};
    if (brand_id) where.brand_id = parsePositiveInt(brand_id, 'brand_id');
    if (is_active !== undefined)
      where.is_active = parseOptionalBoolean(is_active, 'is_active');

    // Mengambil daftar reward dari database
    const rewards = await prisma.rewardsCatalog.findMany({
      where,
      include: { brand: { select: { id: true, name: true } } },
      orderBy: { created_at: 'desc' },
    });

    // Mengirim daftar reward
    res.json(rewards);
  } catch (error) {
    // Menangani error validasi
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    // Menangani error lainnya
    res.status(500).json({ error: error.message });
  }
}

// ===================== GET DETAIL REWARD =====================

// Mengambil detail satu reward berdasarkan ID
// GET /api/rewards-catalog/:id
async function getOne(req, res) {
  try {
    // Memvalidasi ID reward
    const id = parsePositiveInt(req.params.id, 'id');

    // Mengambil data reward
    const reward = await prisma.rewardsCatalog.findUnique({
      where: { id },
      include: { brand: { select: { id: true, name: true } } },
    });

    // Jika reward tidak ditemukan
    if (!reward) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    // Mengirim detail reward
    res.json(reward);
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    res.status(500).json({ error: error.message });
  }
}

// ===================== CREATE REWARD =====================

// Menambahkan reward baru ke database
// POST /api/rewards-catalog
async function create(req, res) {
  try {
    // Mengambil data dari request
    const {
      brand_id,
      name,
      description,
      points_required,
      image_url,
      is_active,
    } = req.body;

    // Memastikan data wajib telah diisi
    if (!brand_id || !name || points_required === undefined) {
      return res
        .status(400)
        .json({ message: 'brand_id, name, dan points_required wajib diisi' });
    }

    // Memvalidasi data input
    const parsedBrandId = parsePositiveInt(brand_id, 'brand_id');
    const parsedPointsRequired = parsePositiveInt(
      points_required,
      'points_required',
    );
    const parsedIsActive = parseOptionalBoolean(is_active, 'is_active') ?? true;

    // Menyimpan reward baru ke database
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

    // Mengirim data reward yang berhasil dibuat
    res.status(201).json(reward);
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    // Menangani jika brand tidak ditemukan
    if (error.code === 'P2003') {
      return res.status(400).json({ message: 'brand_id tidak valid' });
    }
    res.status(500).json({ error: error.message });
  }
}

// ===================== UPDATE REWARD =====================

// Memperbarui data reward
// PUT /api/rewards-catalog/:id
async function update(req, res) {
  try {
    // Memvalidasi ID reward
    const id = parsePositiveInt(req.params.id, 'id');
    // Mengambil data dari request
    const {
      brand_id,
      name,
      description,
      points_required,
      image_url,
      is_active,
    } = req.body;

    // Mengecek apakah reward ada
    const existing = await prisma.rewardsCatalog.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    // Memperbarui data reward
    const reward = await prisma.rewardsCatalog.update({
      where: { id },
      data: {
        ...(brand_id !== undefined && {
          brand_id: parsePositiveInt(brand_id, 'brand_id'),
        }),
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

    // Mengirim data reward terbaru
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

// ===================== DELETE REWARD =====================

// Menghapus reward berdasarkan ID
// DELETE /api/rewards-catalog/:id
async function remove(req, res) {
  try {
    // Memvalidasi ID reward
    const id = parsePositiveInt(req.params.id, 'id');

    // Mengecek apakah reward ada
    const existing = await prisma.rewardsCatalog.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Reward tidak ditemukan' });
    }

    // Menghapus reward dari database
    await prisma.rewardsCatalog.delete({ where: { id } });

    // Mengirim pesan berhasil
    res.json({ message: 'Reward berhasil dihapus' });
  } catch (error) {
    if (error.message?.includes('harus')) {
      return validationError(res, error);
    }

    // Reward tidak dapat dihapus karena masih digunakan
    if (error.code === 'P2003') {
      return res.status(409).json({
        message:
          'Reward tidak bisa dihapus karena masih ada data redemption terkait',
      });
    }
    res.status(500).json({ error: error.message });
  }
}

module.exports = { getAll, getOne, create, update, remove };
