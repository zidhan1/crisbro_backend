// Cache Service - Consistent caching strategies for all services
const {
  setSharedResponseCacheHeaders,
  setPrivateResponseCacheHeaders,
} = require('../../lib/responseCache');

// ===================== CACHE CONFIGURATION =====================

/**
 * Cache TTL configurations (in milliseconds)
 */
const CacheTTL = {
  // Short TTL (1-5 minutes) - Frequently changing data
  SHORT: 1 * 60 * 1000,           // 1 minute
  MEDIUM_SHORT: 3 * 60 * 1000,    // 3 minutes

  // Medium TTL (5-15 minutes) - Moderately changing data
  MEDIUM: 5 * 60 * 1000,          // 5 minutes
  MEDIUM_LONG: 10 * 60 * 1000,    // 10 minutes

  // Long TTL (15-60 minutes) - Relatively stable data
  LONG: 15 * 60 * 1000,           // 15 minutes
  VERY_LONG: 30 * 60 * 1000,      // 30 minutes

  // Extended TTL (1-24 hours) - Very stable data
  EXTENDED: 60 * 60 * 1000,       // 1 hour
  DAILY: 24 * 60 * 60 * 1000,    // 24 hours
};

/**
 * Cache strategies for different data types
 */
const CacheStrategies = {
  // Product catalog - changes moderately often
  PRODUCTS: CacheTTL.MEDIUM,
  PRODUCT_CATEGORIES: CacheTTL.LONG,

  // Locations - relatively stable
  LOCATIONS: CacheTTL.LONG,
  LOCATION_DETAILS: CacheTTL.VERY_LONG,

  // Promos - change frequently
  PROMOS: CacheTTL.MEDIUM_SHORT,
  ACTIVE_PROMOS: CacheTTL.SHORT,

  // Redeem menu - changes moderately
  REDEEM_MENU: CacheTTL.MEDIUM,

  // Rewards catalog - changes moderately
  REWARDS_CATALOG: CacheTTL.MEDIUM,

  // User data - should use private cache
  USER_PROFILE: CacheTTL.SHORT,
  USER_POINTS: CacheTTL.MEDIUM_SHORT,

  // Admin data - use private cache
  ADMIN_SUMMARY: CacheTTL.MEDIUM_SHORT,
  ADMIN_REPORTS: CacheTTL.MEDIUM,
};

// ===================== CACHE HELPERS =====================

/**
 * Apply shared cache headers to response
 * @param {Object} res - Express response object
 * @param {string} dataType - The type of data being cached
 * @param {number} customTtl - Optional custom TTL in milliseconds
 */
function applySharedCache(res, dataType, customTtl = null) {
  const ttl = customTtl || CacheStrategies[dataType] || CacheTTL.MEDIUM;
  setSharedResponseCacheHeaders(res, ttl);
}

/**
 * Apply private cache headers to response
 * @param {Object} res - Express response object
 * @param {string} dataType - The type of data being cached
 * @param {number} customTtl - Optional custom TTL in milliseconds
 */
function applyPrivateCache(res, dataType, customTtl = null) {
  const ttl = customTtl || CacheStrategies[dataType] || CacheTTL.SHORT;
  setPrivateResponseCacheHeaders(res, ttl);
}

/**
 * Apply no-cache headers to response
 * @param {Object} res - Express response object
 */
function applyNoCache(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

/**
 * Generate cache key for caching service responses
 * @param {string} prefix - Cache key prefix (e.g., 'products', 'locations')
 * @param {Object} params - Parameters that affect the response
 * @returns {string} Generated cache key
 */
function generateCacheKey(prefix, params = {}) {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${JSON.stringify(params[key])}`)
    .join('&');

  return sortedParams ? `${prefix}:${sortedParams}` : prefix;
}

/**
 * Parse cache control header from request
 * @param {Object} req - Express request object
 * @returns {Object} Parsed cache control directives
 */
function parseCacheControl(req) {
  const cacheControl = req.get('Cache-Control') || '';
  const directives = {};

  cacheControl.split(',').forEach(directive => {
    const [key, value] = directive.trim().split('=');
    directives[key] = value === undefined ? true : value;
  });

  return directives;
}

/**
 * Check if request allows caching
 * @param {Object} req - Express request object
 * @returns {boolean} True if caching is allowed
 */
function isCacheAllowed(req) {
  const cacheControl = parseCacheControl(req);

  // Don't cache if no-cache directive is present
  if (cacheControl['no-cache']) return false;

  // Don't cache if no-store directive is present
  if (cacheControl['no-store']) return false;

  // Don't cache if authorization header is present (for shared cache)
  if (req.get('authorization')) return false;

  return true;
}

/**
 * Check if response can be cached based on status code
 * @param {number} statusCode - HTTP status code
 * @returns {boolean} True if response is cacheable
 */
function isCacheableStatus(statusCode) {
  // Only cache successful responses
  return statusCode >= 200 && statusCode < 300;
}

// ===================== CACHE MIDDLEWARE =====================

/**
 * Middleware factory for shared caching
 * @param {string} dataType - The type of data being cached
 * @param {number} customTtl - Optional custom TTL
 * @returns {Function} Express middleware
 */
function sharedCache(dataType, customTtl = null) {
  return (req, res, next) => {
    // Apply cache headers
    applySharedCache(res, dataType, customTtl);

    // Store original json method to intercept responses
    const originalJson = res.json.bind(res);

    res.json = function(data) {
      // Only apply cache if status is cacheable
      if (isCacheableStatus(res.statusCode)) {
        applySharedCache(res, dataType, customTtl);
      }
      return originalJson(data);
    };

    next();
  };
}

/**
 * Middleware factory for private caching
 * @param {string} dataType - The type of data being cached
 * @param {number} customTtl - Optional custom TTL
 * @returns {Function} Express middleware
 */
function privateCache(dataType, customTtl = null) {
  return (req, res, next) => {
    // Apply cache headers
    applyPrivateCache(res, dataType, customTtl);

    // Store original json method to intercept responses
    const originalJson = res.json.bind(res);

    res.json = function(data) {
      // Only apply cache if status is cacheable
      if (isCacheableStatus(res.statusCode)) {
        applyPrivateCache(res, dataType, customTtl);
      }
      return originalJson(data);
    };

    next();
  };
}

/**
 * Middleware to prevent caching
 * @returns {Function} Express middleware
 */
function noCache() {
  return (req, res, next) => {
    applyNoCache(res);
    next();
  };
}

// ===================== EXPORTS =====================

module.exports = {
  // Cache TTL configurations
  CacheTTL,
  CacheStrategies,

  // Cache helpers
  applySharedCache,
  applyPrivateCache,
  applyNoCache,
  generateCacheKey,
  parseCacheControl,
  isCacheAllowed,
  isCacheableStatus,

  // Cache middleware
  sharedCache,
  privateCache,
  noCache,
};