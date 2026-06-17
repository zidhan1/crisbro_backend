// src/routes/promoRoutes.js
const express = require('express');
const router = express.Router();
const { fetchAllPromos } = require('../services/runchiseService');

// GET /api/promos
router.get('/', async (req, res) => {
  try {
    const promos = await fetchAllPromos();

    const result = promos.map((p) => {
      // Gunakan is_select_all_location langsung dari Runchise
      const isAllOutlets = p.is_select_all_location === true;

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        start_date: p.start_date,
        end_date: p.end_date ?? null,
        channel: p.channel ?? null,
        is_all_outlets: isAllOutlets,
        // Kirim locations hanya jika bukan semua outlet
        locations: isAllOutlets
          ? []
          : (p.locations ?? []).map((loc) => ({
              id: loc.id,
              name: loc.name,
            })),
        discount_amount: p.promo_reward?.discount_amount
          ? parseFloat(p.promo_reward.discount_amount)
          : null,
        discount_is_percentage: p.promo_reward?.discount_is_percentage ?? false,
        template: p.promo_reward?.template ?? null,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Promo fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
