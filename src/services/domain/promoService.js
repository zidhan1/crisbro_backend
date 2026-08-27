// Promo Service - Promotion business logic
const prisma = require('../../lib/prisma');

// ===================== CONSTANTS =====================

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 24;
const ALLOWED_STATUSES = new Set(['active', 'completed', 'inactive']);

// ===================== VALIDATION HELPERS =====================

/**
 * Convert value to positive integer with fallback
 * @param {*} value - The value to convert
 * @param {number} fallback - The fallback value
 * @returns {number} The positive integer or fallback
 */
function toPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

/**
 * Validate and sanitize pagination parameters
 * @param {Object} params - Query parameters
 * @returns {Object} Validated pagination parameters
 */
function validatePagination(params = {}) {
  const page = toPositiveInteger(params.page, DEFAULT_PAGE);
  const limit = Math.min(toPositiveInteger(params.limit, DEFAULT_LIMIT), MAX_LIMIT);

  return { page, limit };
}

/**
 * Validate promo status
 * @param {string} status - The status to validate
 * @returns {boolean} True if status is valid
 */
function isValidStatus(status) {
  if (!status) return true; // Empty status means no filter
  return ALLOWED_STATUSES.has(status);
}

// ===================== QUERY BUILDING =====================

/**
 * Build WHERE clause for promo queries
 * @param {string} status - Optional status filter
 * @param {Date} now - Current date for validity window (defaults to new Date())
 * @returns {Object} Prisma WHERE clause
 */
function buildPromoWhere(status, now = new Date()) {
  const whereClause = {
    is_visible: true,
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

  // Add status filter if provided
  if (status) {
    whereClause.status = status;
  }

  return whereClause;
}

/**
 * Build promo query options
 * @param {Object} params - Query parameters
 * @returns {Object} Query options with validation
 */
function buildPromoQuery(params = {}) {
  const { page, limit } = validatePagination(params);
  const status = typeof params.status === 'string' ? params.status : '';

  // Validate status
  if (status && !isValidStatus(status)) {
    throw new Error(
      `Status promo tidak valid. Gunakan salah satu: ${Array.from(ALLOWED_STATUSES).join(', ')}`
    );
  }

  const where = buildPromoWhere(status, new Date());
  const usePaginatedResponse =
    params.page !== undefined ||
    params.limit !== undefined ||
    params.status !== undefined;

  return {
    where,
    page,
    limit,
    usePaginatedResponse,
  };
}

// ===================== PROMO QUERIES =====================

/**
 * Get promos with optional filtering and pagination
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>} Promos with pagination metadata
 */
async function getPromos(params = {}) {
  const queryOptions = buildPromoQuery(params);
  const { where, page, limit, usePaginatedResponse } = queryOptions;

  if (usePaginatedResponse) {
    // Paginated query
    const [total, promos] = await Promise.all([
      prisma.promo.count({ where }),
      prisma.promo.findMany({
        where,
        orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const clampedPage = Math.min(page, totalPages);

    return {
      items: formatPromosForAPI(promos),
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
    };
  }

  // Non-paginated query
  const promos = await prisma.promo.findMany({
    where,
    orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
  });

  return formatPromosForAPI(promos);
}

/**
 * Get promo by ID
 * @param {number} promoId - The promo ID
 * @returns {Promise<Object|null>} The promo or null if not found
 */
async function getPromoById(promoId) {
  const promo = await prisma.promo.findFirst({
    where: {
      runchise_id: Number(promoId),
      is_visible: true,
    },
  });

  return promo ? formatPromoForAPI(promo) : null;
}

/**
 * Get active promos
 * @param {Object} params - Optional query parameters
 * @returns {Promise<Object>} Active promos with pagination
 */
async function getActivePromos(params = {}) {
  return getPromos({ ...params, status: 'active' });
}

/**
 * Get promos by status
 * @param {string} status - The status to filter by
 * @param {Object} params - Optional query parameters
 * @returns {Promise<Object>} Promos with pagination
 */
async function getPromosByStatus(status, params = {}) {
  return getPromos({ ...params, status });
}

// ===================== PROMO TRANSFORMATION =====================

/**
 * Transform database promo to API response format
 * @param {Object} promo - The promo from database
 * @returns {Object} Formatted promo for API response
 */
function formatPromoForAPI(promo) {
  if (!promo) return null;

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

/**
 * Transform multiple promos to API response format
 * @param {Array} promos - Array of promos from database
 * @returns {Array} Formatted promos for API response
 */
function formatPromosForAPI(promos) {
  return promos.map(formatPromoForAPI).filter(Boolean);
}

// ===================== EXPORTS =====================

module.exports = {
  // Constants
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ALLOWED_STATUSES,

  // Validation helpers
  toPositiveInteger,
  validatePagination,
  isValidStatus,

  // Query building
  buildPromoWhere,
  buildPromoQuery,

  // Promo queries
  getPromos,
  getPromoById,
  getActivePromos,
  getPromosByStatus,

  // Promo transformation
  formatPromoForAPI,
  formatPromosForAPI,
};