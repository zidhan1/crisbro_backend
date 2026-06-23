const express = require('express');
const prisma = require('../lib/prisma');
const {
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
} = require('../constants/crisbroRedeemMenu');

const router = express.Router();
const CRISBRO_BRAND_ID = 1;

// GET /api/catalog/redeem-menu
router.get('/', async (req, res) => {
  try {
    const allowedMenuLookup = buildCrisbroRedeemMenuLookup();
    const allowedMenuNames = Array.from(allowedMenuLookup.keys());

    const items = await prisma.menuItem.findMany({
      where: {
        brand_id: CRISBRO_BRAND_ID,
        is_active: true,
      },
      orderBy: { name: 'asc' },
    });

    const result = items
      .map((item) => ({
        item,
        menuName: normalizeMenuName(item.name),
        menuConfig: allowedMenuLookup.get(normalizeMenuName(item.name)),
      }))
      .filter(({ menuName, menuConfig }) => {
        return menuConfig && allowedMenuNames.includes(menuName);
      })
      .sort((a, b) => {
        if (a.menuConfig.categoryIndex !== b.menuConfig.categoryIndex) {
          return a.menuConfig.categoryIndex - b.menuConfig.categoryIndex;
        }

        return a.menuConfig.itemIndex - b.menuConfig.itemIndex;
      })
      .map(({ item, menuConfig }) => ({
        id: item.id,
        sku: item.runchise_id ? `RUNCHISE-${item.runchise_id}` : `MENU-${item.id}`,
        name: item.name,
        description: item.description,
        points_required: Number(item.price),
        image_url: item.image_url,
        category: menuConfig.categoryName,
        category_id: menuConfig.categoryIndex,
        sort_order: menuConfig.itemIndex,
      }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
