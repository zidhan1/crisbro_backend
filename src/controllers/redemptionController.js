const prisma = require('../lib/prisma');
const crypto = require('crypto'); // Mengimpor crypto untuk membuat kode redeem secara acak

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function createRedemptionWithRetry(tx, data, maxAttempts = 5) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await tx.rewardRedemption.create({
        data: {
          ...data,
          redemption_code: crypto.randomBytes(4).toString('hex').toUpperCase(),
        },
      });
    } catch (error) {
      if (error.code !== 'P2002') throw error;
      lastError = error;
    }
  }

  throw lastError;
}

function isRedeemItemAvailable(item, now = new Date()) {
  return (
    item &&
    item.is_active &&
    item.category?.is_active &&
    item.menu_item?.is_active &&
    (!item.start_at || item.start_at <= now) &&
    (!item.end_at || item.end_at >= now)
  );
}

// Menangani proses penukaran reward oleh customer
// POST /api/redeem/:rewardId
async function redeemReward(req, res) {
  // Mengambil ID reward dan ID user yang sedang login
  const rewardId = parsePositiveInteger(req.params.rewardId);
  const userId = req.user.id;

  if (rewardId === null) {
    return res.status(400).json({ message: 'ID reward tidak valid' });
  }

  try {
    // 1. Mengambil data customer beserta poinnya
    const customer = await prisma.customer.findUnique({
      where: { user_id: userId },
      include: { customer_point: true },
    });

    // Jika customer tidak ditemukan
    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    // 2. Mengecek apakah reward tersedia dan masih aktif
    const reward = await prisma.rewardsCatalog.findUnique({
      where: { id: rewardId },
    });

    if (!reward || !reward.is_active) {
      return res
        .status(404)
        .json({ message: 'Reward tidak ditemukan atau tidak aktif' });
    }

    // 3. Memastikan poin customer mencukupi
    const availablePoint = customer.customer_point?.available_point ?? 0;
    if (availablePoint < reward.points_required) {
      return res.status(400).json({
        message: 'Poin tidak cukup',
        available_point: availablePoint,
        points_required: reward.points_required,
      });
    }

    // 4. Menjalankan seluruh proses penukaran dalam satu transaksi database
    const result = await prisma.$transaction(async (tx) => {
      // Kurangi poin secara atomic. Kondisi available_point menjaga agar
      // request paralel tidak bisa sama-sama membuat saldo menjadi minus.
      const pointUpdate = await tx.customerPoint.updateMany({
        where: {
          customer_id: customer.id,
          available_point: { gte: reward.points_required },
        },
        data: {
          available_point: { decrement: reward.points_required },
        },
      });

      if (pointUpdate.count !== 1) {
        throw Object.assign(new Error('Poin tidak cukup'), {
          statusCode: 400,
          payload: {
            message: 'Poin tidak cukup',
            points_required: reward.points_required,
          },
        });
      }

      // Membuat data riwayat penukaran reward
      const redemption = await createRedemptionWithRetry(tx, {
        customer_id: customer.id,
        reward_id: rewardId,
        points_spent: reward.points_required,
        status: 'pending',
      });

      // Menyimpan riwayat perubahan poin
      await tx.pointHistory.create({
        data: {
          customer_id: customer.id,
          reward_redemption_id: redemption.id,
          points_change: -reward.points_required,
          type: 'redeem',
          description: `Penukaran reward: ${reward.name}`,
        },
      });

      const updatedPoint = await tx.customerPoint.findUnique({
        where: { customer_id: customer.id },
      });

      return { redemption, updatedPoint };
    });

    // Mengirim hasil penukaran reward
    return res.status(201).json({
      message: 'Reward berhasil ditukar!',
      redemption_code: result.redemption.redemption_code,
      points_spent: reward.points_required,
      available_point: result.updatedPoint.available_point,
    });
  } catch (error) {
    if (error.statusCode && error.payload) {
      return res.status(error.statusCode).json(error.payload);
    }

    // Menangani error saat proses redeem
    return res.status(500).json({ error: error.message });
  }
}

// Menangani proses penukaran menu redeem oleh customer
// POST /api/redeem/menu/:redeemMenuItemId
async function redeemMenuItem(req, res) {
  const redeemMenuItemId = parsePositiveInteger(req.params.redeemMenuItemId);
  const userId = req.user.id;

  if (redeemMenuItemId === null) {
    return res.status(400).json({ message: 'ID menu redeem tidak valid' });
  }

  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: userId },
      include: { customer_point: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    const redeemItem = await prisma.redeemMenuItem.findUnique({
      where: { id: redeemMenuItemId },
      include: {
        category: true,
        menu_item: true,
      },
    });

    if (!isRedeemItemAvailable(redeemItem)) {
      return res
        .status(404)
        .json({ message: 'Menu redeem tidak ditemukan atau tidak aktif' });
    }

    const availablePoint = customer.customer_point?.available_point ?? 0;
    if (availablePoint < redeemItem.points_required) {
      return res.status(400).json({
        message: 'Poin tidak cukup',
        available_point: availablePoint,
        points_required: redeemItem.points_required,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const pointUpdate = await tx.customerPoint.updateMany({
        where: {
          customer_id: customer.id,
          available_point: { gte: redeemItem.points_required },
        },
        data: {
          available_point: { decrement: redeemItem.points_required },
        },
      });

      if (pointUpdate.count !== 1) {
        throw Object.assign(new Error('Poin tidak cukup'), {
          statusCode: 400,
          payload: {
            message: 'Poin tidak cukup',
            points_required: redeemItem.points_required,
          },
        });
      }

      let reward = await tx.rewardsCatalog.findFirst({
        where: {
          brand_id: redeemItem.menu_item.brand_id,
          name: redeemItem.menu_item.name,
        },
        orderBy: { id: 'asc' },
      });

      if (!reward) {
        reward = await tx.rewardsCatalog.create({
          data: {
            brand_id: redeemItem.menu_item.brand_id,
            name: redeemItem.menu_item.name,
            description: redeemItem.menu_item.description,
            points_required: redeemItem.points_required,
            image_url: redeemItem.menu_item.image_url,
            is_active: true,
          },
        });
      }

      const redemption = await createRedemptionWithRetry(tx, {
        customer_id: customer.id,
        reward_id: reward.id,
        points_spent: redeemItem.points_required,
        status: 'pending',
      });

      await tx.pointHistory.create({
        data: {
          customer_id: customer.id,
          reward_redemption_id: redemption.id,
          points_change: -redeemItem.points_required,
          type: 'redeem',
          description: `Penukaran menu redeem: ${redeemItem.menu_item.name}`,
        },
      });

      const updatedPoint = await tx.customerPoint.findUnique({
        where: { customer_id: customer.id },
      });

      return { redemption, reward, updatedPoint };
    });

    return res.status(201).json({
      message: 'Menu berhasil ditukar!',
      redemption_id: result.redemption.id,
      redemption_code: result.redemption.redemption_code,
      points_spent: redeemItem.points_required,
      available_point: result.updatedPoint.available_point,
      reward: {
        id: result.reward.id,
        name: result.reward.name,
        image_url: result.reward.image_url,
      },
      menu_item: {
        id: redeemItem.menu_item.id,
        name: redeemItem.menu_item.name,
        image_url: redeemItem.menu_item.image_url,
      },
    });
  } catch (error) {
    if (error.statusCode && error.payload) {
      return res.status(error.statusCode).json(error.payload);
    }

    return res.status(500).json({ error: error.message });
  }
}

// ===================== RIWAYAT REDEEM =====================
// Mengambil daftar reward yang pernah ditukar oleh customer
// GET /api/my-redemptions
async function getMyRedemptions(req, res) {
  try {
    // Mengambil data customer berdasarkan user yang login
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
    });

    // Jika customer tidak ditemukan
    if (!customer)
      return res.status(404).json({ message: 'Customer tidak ditemukan' });

    // Mengambil seluruh riwayat penukaran reward customer
    const redemptions = await prisma.rewardRedemption.findMany({
      where: { customer_id: customer.id },
      include: { reward: { select: { name: true, image_url: true } } },
      orderBy: { id: 'desc' },
    });

    // Mengirim daftar riwayat redeem
    res.json(redemptions);
  } catch (error) {
    // Menangani error saat mengambil data
    res.status(500).json({ error: error.message });
  }
}

// Mengekspor fungsi agar dapat digunakan pada file route
module.exports = { redeemReward, redeemMenuItem, getMyRedemptions };
