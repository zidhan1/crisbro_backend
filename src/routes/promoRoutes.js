const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { createResponseCache } = require('../lib/responseCache');

const cache = createResponseCache(
  Number(process.env.PROMO_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000),
);

// GET /api/promos
router.get('/', async (req, res) => {
  try {
    const cacheKey = 'promos:visible';
    const cached = cache.get(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const promos = await prisma.promo.findMany({
      where: { is_visible: true },
      orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
    });

    const result = promos.map((promo) => ({
      id: promo.runchise_id,
      name: promo.name,
      status: promo.status,
      start_date: promo.start_date,
      end_date: promo.end_date,
      channel: promo.channel,
      is_online_only: promo.is_online_only,
      is_all_outlets: promo.is_all_outlets,
      locations: promo.locations ?? [],
      discount_amount: promo.discount_amount
        ? Number(promo.discount_amount)
        : null,
      discount_is_percentage: promo.discount_is_percentage,
      template: promo.template,
    }));

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
