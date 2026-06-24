const express = require('express');
const prisma = require('../lib/prisma');

// Mengimpor konfigurasi menu redeem Crisbro
const {
  CRISBRO_REDEEM_MENU_CATEGORY_NAME,
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
} = require('../constants/crisbroRedeemMenu');

// Membuat router Express
const router = express.Router();

// ID brand Crisbro (hardcoded)
const CRISBRO_BRAND_ID = 1;

// ===================== GET REDEEM MENU =====================

// Endpoint untuk mengambil menu yang bisa ditukar poin (redeem menu)
// GET /api/catalog/redeem-menu
router.get('/', async (req, res) => {
  try {
    // Membuat lookup menu redeem (mapping nama menu → kategori & index)
    const allowedMenuLookup = buildCrisbroRedeemMenuLookup();

    // Mengambil semua menu item aktif dari database
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

    // Filter + mapping menu yang boleh masuk redeem list
    const result = items
      .map((item) => ({
        item,
        menuConfig: allowedMenuLookup.get(normalizeMenuName(item.name)),
      }))
      .filter(({ item, menuConfig }) => {
        const categoryName = item.category?.name?.trim();

        // Jika kategori utama redeem, selalu ditampilkan
        if (categoryName === CRISBRO_REDEEM_MENU_CATEGORY_NAME) {
          return true;
        }

        // Selain itu hanya yang ada di whitelist redeem config
        return menuConfig?.categoryName === categoryName;
      })
      // Sorting menu berdasarkan kategori & urutan custom
      .sort((a, b) => {
        // urutkan berdasarkan sort_order kategori
        const categorySortA = a.item.category?.sort_order ?? 0;
        const categorySortB = b.item.category?.sort_order ?? 0;

        if (categorySortA !== categorySortB) {
          return categorySortA - categorySortB;
        }

        // kategori default redeem diurutkan berdasarkan nama
        if (a.item.category?.name === CRISBRO_REDEEM_MENU_CATEGORY_NAME) {
          return a.item.name.localeCompare(b.item.name);
        }

        // urutan berdasarkan config redeem menu
        const categoryIndexA = a.menuConfig?.categoryIndex ?? 999;
        const categoryIndexB = b.menuConfig?.categoryIndex ?? 999;
        const itemIndexA = a.menuConfig?.itemIndex ?? 999;
        const itemIndexB = b.menuConfig?.itemIndex ?? 999;

        if (categoryIndexA !== categoryIndexB) {
          return categoryIndexA - categoryIndexB;
        }

        return itemIndexA - itemIndexB;
      })
      // Format response untuk frontend
      .map(({ item, menuConfig }) => ({
        id: item.id,
        sku: item.runchise_id
          ? `RUNCHISE-${item.runchise_id}`
          : `MENU-${item.id}`,
        name: item.name,
        description: item.description,
        points_required: Number(item.price), // harga dipakai sebagai poin redeem
        image_url: item.image_url,
        category: item.category?.name ?? menuConfig?.categoryName ?? null,
        category_id: item.category?.id ?? menuConfig?.categoryIndex ?? null,
        // urutan tampil menu redeem
        sort_order:
          item.category?.name === CRISBRO_REDEEM_MENU_CATEGORY_NAME
            ? 0
            : (menuConfig?.itemIndex ?? 0),
      }));

    // Mengirim hasil ke frontend
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
