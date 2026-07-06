const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/catalog/redeem-menu
router.get('/', async (req, res) => {
  try {
    const now = new Date();
    const items = await prisma.redeemMenuItem.findMany({
      where: {
        is_active: true,
        category: { is_active: true },
        menu_item: { is_active: true },
        OR: [{ start_at: null }, { start_at: { lte: now } }],
        AND: [{ OR: [{ end_at: null }, { end_at: { gte: now } }] }],
      },
      select: {
        id: true,
        points_required: true,
        badge: true,
        sort_order: true,
        category: {
          select: {
            id: true,
            name: true,
          },
        },
        menu_item: {
          select: {
            id: true,
            runchise_id: true,
            name: true,
            description: true,
            image_url: true,
          },
        },
      },
      orderBy: [
        { category: { sort_order: 'asc' } },
        { sort_order: 'asc' },
        { id: 'asc' },
      ],
    });

    const result = items.map((item) => ({
      id: item.id,
      sku: item.menu_item.runchise_id
        ? `RUNCHISE-${item.menu_item.runchise_id}`
        : `MENU-${item.menu_item.id}`,
      name: item.menu_item.name,
      description: item.menu_item.description,
      points_required: item.points_required,
      image_url: item.menu_item.image_url,
      category: item.category.name,
      category_id: item.category.id,
      badge: item.badge,
      sort_order: item.sort_order,
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
