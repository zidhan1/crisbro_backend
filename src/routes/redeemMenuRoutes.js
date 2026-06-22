const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/catalog/redeem-menu
router.get('/', async (req, res) => {
  try {
    const rewards = await prisma.rewardsCatalog.findMany({
      where: { is_active: true },
      include: { brand: { select: { id: true, name: true } } },
      orderBy: [{ points_required: 'asc' }, { name: 'asc' }],
    });

    const result = rewards.map((reward, index) => ({
      id: reward.id,
      sku: `REWARD-${reward.id}`,
      name: reward.name,
      description: reward.description,
      points_required: reward.points_required,
      image_url: reward.image_url,
      category: reward.brand?.name ?? 'Reward',
      category_id: reward.brand_id,
      sort_order: index,
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
