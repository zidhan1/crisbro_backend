const prisma = require('../lib/prisma');
const crypto = require('crypto');

// POST /api/redeem/:rewardId
async function redeemReward(req, res) {
  const rewardId = Number(req.params.rewardId);
  const userId = req.user.id;

  try {
    // 1. Ambil customer berdasarkan user yang login
    const customer = await prisma.customer.findUnique({
      where: { user_id: userId },
      include: { customer_point: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    // 2. Cek reward ada & aktif
    const reward = await prisma.rewardsCatalog.findUnique({
      where: { id: rewardId },
    });

    if (!reward || !reward.is_active) {
      return res.status(404).json({ message: 'Reward tidak ditemukan atau tidak aktif' });
    }

    // 3. Cek poin cukup
    const availablePoint = customer.customer_point?.available_point ?? 0;
    if (availablePoint < reward.points_required) {
      return res.status(400).json({
        message: 'Poin tidak cukup',
        available_point: availablePoint,
        points_required: reward.points_required,
      });
    }

    // 4. Jalankan transaksi atomik
    const result = await prisma.$transaction(async (tx) => {
      // Buat redemption record
      const redemption = await tx.rewardRedemption.create({
        data: {
          customer_id:     customer.id,
          reward_id:       rewardId,
          points_spent:    reward.points_required,
          status:          'pending',
          redemption_code: crypto.randomBytes(4).toString('hex').toUpperCase(),
        },
      });

      // Catat point history
      await tx.pointHistory.create({
        data: {
          customer_id:          customer.id,
          reward_redemption_id: redemption.id,
          points_change:        -reward.points_required,
          type:                 'redeem',
          description:          `Penukaran reward: ${reward.name}`,
        },
      });

      // Kurangi available_point
      const updatedPoint = await tx.customerPoint.update({
        where: { customer_id: customer.id },
        data: {
          available_point: { decrement: reward.points_required },
        },
      });

      return { redemption, updatedPoint };
    });

    return res.status(201).json({
      message: 'Reward berhasil ditukar!',
      redemption_code: result.redemption.redemption_code,
      points_spent:    reward.points_required,
      available_point: result.updatedPoint.available_point,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// GET /api/my-redemptions
async function getMyRedemptions(req, res) {
  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
    });

    if (!customer) return res.status(404).json({ message: 'Customer tidak ditemukan' });

    const redemptions = await prisma.rewardRedemption.findMany({
      where: { customer_id: customer.id },
      include: { reward: { select: { name: true, image_url: true } } },
      orderBy: { id: 'desc' },
    });

    res.json(redemptions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = { redeemReward, getMyRedemptions };