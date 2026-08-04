const prisma = require('../lib/prisma');

// Reward yang benar-benar bisa ditukar saat ini. Filternya disamakan dengan
// GET /api/catalog/redeem-menu supaya target progress bar di dashboard tidak
// pernah menunjuk reward yang tidak muncul di katalog.
function buildRedeemableWhere(now = new Date()) {
  return {
    is_active: true,
    menu_item: { is_active: true, is_selectable: true },
    category: { is_active: true },
    OR: [{ start_at: null }, { start_at: { lte: now } }],
    AND: [{ OR: [{ end_at: null }, { end_at: { gte: now } }] }],
  };
}

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
    prisma.redeemMenuItem.findFirst({
      where: { ...where, points_required: { gt: points } },
      orderBy: [{ points_required: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        points_required: true,
        menu_item: { select: { name: true, image_url: true } },
      },
    }),
    // Dipakai frontend untuk membedakan "semua reward sudah terjangkau" dari
    // "katalog reward memang sedang kosong".
    prisma.redeemMenuItem.count({
      where: { ...where, points_required: { lte: points } },
    }),
  ]);

  return {
    next_reward: nextItem
      ? {
          id: nextItem.id,
          name: nextItem.menu_item.name,
          image_url: nextItem.menu_item.image_url,
          points_required: nextItem.points_required,
          points_remaining: Math.max(0, nextItem.points_required - points),
        }
      : null,
    redeemable_reward_count: redeemableCount,
  };
}

module.exports = { getNextReward };
