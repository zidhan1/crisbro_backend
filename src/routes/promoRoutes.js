const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { createResponseCache } = require('../lib/responseCache');

const cache = createResponseCache(
  Number(process.env.PROMO_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000),
);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 24;
const ALLOWED_STATUSES = new Set(['active', 'completed', 'inactive']);

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

function mapPromo(promo) {
  return {
    id: promo.runchise_id,
    name: promo.name,
    status: promo.status,
    start_date: promo.start_date,
    end_date: promo.end_date,
    channel: promo.channel,
    is_online_only: promo.is_online_only,
    is_all_outlets: promo.is_all_outlets,
    locations: promo.locations ?? [],
    discount_amount: promo.discount_amount ? Number(promo.discount_amount) : null,
    discount_is_percentage: promo.discount_is_percentage,
    template: promo.template,
  };
}

// GET /api/promos
router.get('/', async (req, res) => {
  try {
    const page = toPositiveInteger(req.query.page, DEFAULT_PAGE);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const usePaginatedResponse =
      req.query.page !== undefined || req.query.limit !== undefined || req.query.status !== undefined;

    if (status && !ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({
        error: `Status promo tidak valid. Gunakan salah satu: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
      });
    }

    const where = {
      is_visible: true,
      ...(status ? { status } : {}),
    };
    const cacheKey = usePaginatedResponse
      ? `promos:visible:page=${page}:limit=${limit}:status=${status || 'all'}`
      : 'promos:visible';
    const cached = cache.get(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    if (usePaginatedResponse) {
      const total = await prisma.promo.count({ where });
      const totalPages = Math.max(Math.ceil(total / limit), 1);
      const clampedPage = Math.min(page, totalPages);
      const promos = await prisma.promo.findMany({
        where,
        orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
        skip: (clampedPage - 1) * limit,
        take: limit,
      });
      const result = {
        items: promos.map(mapPromo),
        page: clampedPage,
        limit,
        total,
        total_pages: totalPages,
      };

      cache.set(cacheKey, result);
      return res.json(result);
    }

    const promos = await prisma.promo.findMany({
      where,
      orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
    });

    const result = promos.map(mapPromo);

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
