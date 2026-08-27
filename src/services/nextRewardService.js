const prisma = require('../lib/prisma');

// Reward yang benar-benar bisa ditukar saat ini. Filternya disamakan dengan
// GET /api/rewards-catalog supaya target progress bar di dashboard selalu
// berasal dari katalog reward yang aktif.
const buildRedeemableWhere = () => ({ is_active: true });

// Target progress bar: reward termurah yang poinnya BELUM terjangkau customer.
//
// Dulu dashboard memakai ambang tetap 2.000 poin, padahal reward nyata berharga
// 3-27 poin, sehingga mayoritas customer yang sebenarnya sudah bisa menukar
// tetap diberi tahu masih kurang ribuan poin. Menghitungnya dari katalog
// membuat target ikut menyesuaikan ketika harga atau menu berubah.
async function getNextReward(availablePoint) {
  const points = Number.isFinite(Number(availablePoint))
    ? Number(availablePoint)
    : 0;
  const where = buildRedeemableWhere();

  const [nextItem, redeemableCount] = await Promise.all([
    prisma.rewardsCatalog.findFirst({
      where: { ...where, points_required: { gt: points } },
      orderBy: [{ points_required: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        image_url: true,
        points_required: true,
      },
    }),
    // Dipakai frontend untuk membedakan "semua reward sudah terjangkau" dari
    // "katalog reward memang sedang kosong".
    prisma.rewardsCatalog.count({
      where: { ...where, points_required: { lte: points } },
    }),
  ]);

  return {
    next_reward: nextItem
      ? {
          id: nextItem.id,
          name: nextItem.name,
          image_url: nextItem.image_url,
          points_required: nextItem.points_required,
          points_remaining: Math.max(0, nextItem.points_required - points),
        }
      : null,
    redeemable_reward_count: redeemableCount,
  };
}

module.exports = { getNextReward };
