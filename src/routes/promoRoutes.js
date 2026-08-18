const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { setSharedResponseCacheHeaders } = require('../lib/responseCache');
const { respondWithServerError } = require('../lib/serverError');

const PROMO_CACHE_TTL_MS = Number(
  process.env.PROMO_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000,
);
function sendCacheableJson(res, value) {
  setSharedResponseCacheHeaders(res, PROMO_CACHE_TTL_MS);
  return res.json(value);
}

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

function buildPromoWhere(status, now = new Date()) {
  return {
    is_visible: true,
    ...(status ? { status } : {}),
    // Sync materializes status/is_visible periodically; the validity window
    // must still be enforced against the request clock.
    AND: [
      {
        OR: [
          { status: { not: 'active' } },
          {
            AND: [
              { OR: [{ start_at: null }, { start_at: { lte: now } }] },
              { OR: [{ end_at: null }, { end_at: { gte: now } }] },
            ],
          },
        ],
      },
    ],
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

    const where = buildPromoWhere(status, new Date());
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

      return sendCacheableJson(res, result);
    }

    const promos = await prisma.promo.findMany({
      where,
      orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
    });

    const result = promos.map(mapPromo);

    sendCacheableJson(res, result);
  } catch (error) {
    respondWithServerError(res, error, 'promoRoutes');
  }
});

module.exports = router;
module.exports.buildPromoWhere = buildPromoWhere;
