const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { fetchAllPromos } = require('../services/runchiseService');

// GET /api/promos
router.get('/', async (req, res) => {
  try {
    // 1. Ambil total outlet aktif dari database lokal untuk perbandingan
    const totalActiveLocations = await prisma.location.count({
      where: { is_active: true }
    });

    // 2. Ambil data promo dari Runchise Service
    const promos = await fetchAllPromos();

    // 3. Mapping data promo dengan kondisi ringkasan lokasi
    const result = promos.map((p) => {
      let promoLocations = p.locations ?? [];

      // Jika jumlah lokasi di promo sama dengan atau melebihi total outlet aktif kita
      if (promoLocations.length >= totalActiveLocations && totalActiveLocations > 0) {
        promoLocations = ["Berlaku di semua outlet"];
      }

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        start_date: p.start_date,
        end_date: p.end_date ?? null,
        channel: p.channel ?? null,
        locations: promoLocations, // Data menjadi bersih & ringan
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