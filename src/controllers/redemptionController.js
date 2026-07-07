const prisma = require('../lib/prisma');
const crypto = require('crypto'); // Mengimpor crypto untuk membuat kode redeem secara acak

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
      const redemption = await tx.rewardRedemption.create({
        data: {
          customer_id: customer.id,
          reward_id: rewardId,
          points_spent: reward.points_required,
          status: 'pending',
          // Membuat kode redeem secara acak
          redemption_code: crypto.randomBytes(4).toString('hex').toUpperCase(),
        },
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
module.exports = { redeemReward, getMyRedemptions };
