const prisma = require('../lib/prisma');

const RUNCHISE_POS_REDEEM_MESSAGE =
  'Penukaran reward dilakukan melalui kasir/POS Runchise. Aplikasi Crisbro hanya menampilkan estimasi penukaran.';

function rejectLocalRedeem(_req, res) {
  return res.status(410).json({
    message: RUNCHISE_POS_REDEEM_MESSAGE,
  });
}

// Redeem resmi dilakukan di kasir/POS Runchise. Endpoint ini sengaja tidak
// membuat RewardRedemption, PointHistory, atau pengurangan poin lokal.
const redeemReward = rejectLocalRedeem;
const redeemMenuItem = rejectLocalRedeem;

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
