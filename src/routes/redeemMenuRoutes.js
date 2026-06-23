const express = require('express');
const prisma = require('../lib/prisma');
const {
  CRISBRO_REDEEM_MENU_CATEGORY_NAME,
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
} = require('../constants/crisbroRedeemMenu');

const router = express.Router();
const CRISBRO_BRAND_ID = 1;

// GET /api/catalog/redeem-menu
router.get('/', async (req, res) => {
  try {
    const allowedMenuLookup = buildCrisbroRedeemMenuLookup();

    const items = await prisma.menuItem.findMany({
      where: {
        brand_id: CRISBRO_BRAND_ID,
        is_active: true,
      },
      include: {
        category: {
          select: { id: true, name: true, sort_order: true },
        },
      },
      orderBy: [{ category: { sort_order: 'asc' } }, { name: 'asc' }],
    });

    const result = items
      .map((item) => ({
        item,
        menuConfig: allowedMenuLookup.get(normalizeMenuName(item.name)),
      }))
      .filter(({ item, menuConfig }) => {
        const categoryName = item.category?.name?.trim();

        if (categoryName === CRISBRO_REDEEM_MENU_CATEGORY_NAME) {
          return true;
        }

        return menuConfig?.categoryName === categoryName;
      })
      .sort((a, b) => {
        const categorySortA = a.item.category?.sort_order ?? 0;
        const categorySortB = b.item.category?.sort_order ?? 0;

        if (categorySortA !== categorySortB) {
          return categorySortA - categorySortB;
        }

        if (a.item.category?.name === CRISBRO_REDEEM_MENU_CATEGORY_NAME) {
          return a.item.name.localeCompare(b.item.name);
        }

        const categoryIndexA = a.menuConfig?.categoryIndex ?? 999;
        const categoryIndexB = b.menuConfig?.categoryIndex ?? 999;
        const itemIndexA = a.menuConfig?.itemIndex ?? 999;
        const itemIndexB = b.menuConfig?.itemIndex ?? 999;

        if (categoryIndexA !== categoryIndexB) {
          return categoryIndexA - categoryIndexB;
        }

        return itemIndexA - itemIndexB;
      })
      .map(({ item, menuConfig }) => ({
        id: item.id,
        sku: item.runchise_id ? `RUNCHISE-${item.runchise_id}` : `MENU-${item.id}`,
        name: item.name,
        description: item.description,
        points_required: Number(item.price),
        image_url: item.image_url,
        category: item.category?.name ?? menuConfig?.categoryName ?? null,
        category_id: item.category?.id ?? menuConfig?.categoryIndex ?? null,
        sort_order: item.category?.name === CRISBRO_REDEEM_MENU_CATEGORY_NAME
          ? 0
          : menuConfig?.itemIndex ?? 0,
      }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
