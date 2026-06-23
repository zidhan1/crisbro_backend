const express = require('express');
const prisma = require('../lib/prisma');
const {
  CRISBRO_REDEEM_ITEM_CATEGORY_NAMES,
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
} = require('../constants/crisbroRedeemMenu');

const router = express.Router();
const CRISBRO_BRAND_ID = 1;

// GET /api/catalog/redeem-menu
router.get('/', async (req, res) => {
  try {
    const allowedMenuLookup = buildCrisbroRedeemMenuLookup();

    const categories = await prisma.menuCategory.findMany({
      where: {
        brand_id: CRISBRO_BRAND_ID,
        is_active: true,
        name: { in: CRISBRO_REDEEM_ITEM_CATEGORY_NAMES },
      },
      include: {
        items: {
          where: { is_active: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });

    const result = categories.flatMap((category) =>
      category.items
        .map((item) => ({
          item,
          menuConfig: allowedMenuLookup.get(normalizeMenuName(item.name)),
        }))
        .filter(({ menuConfig }) => {
          return menuConfig?.categoryName === category.name.trim();
        })
        .sort((a, b) => a.menuConfig.itemIndex - b.menuConfig.itemIndex)
        .map(({ item, menuConfig }) => ({
          id: item.id,
          sku: item.runchise_id ? `RUNCHISE-${item.runchise_id}` : `MENU-${item.id}`,
          name: item.name,
          description: item.description,
          points_required: Number(item.price),
          image_url: item.image_url,
          category: category.name,
          category_id: category.id,
          sort_order: menuConfig.itemIndex,
        })),
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
