// Location Service - Location management business logic
const prisma = require('../../lib/prisma');

// ===================== HELPER FUNCTIONS =====================

/**
 * Convert decimal value to number
 * @param {*} value - The value to convert
 * @returns {number|null} The converted number or null
 */
function decimalToNumber(value) {
  if (value === null || value === undefined) return null;

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * Build Google Maps URL for a location
 * @param {Object} location - The location object
 * @returns {string} Google Maps URL
 */
function buildMapsUrl(location) {
  const latitude = decimalToNumber(location.latitude);
  const longitude = decimalToNumber(location.longitude);

  if (latitude !== null && longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }

  const query = [location.name, location.address, location.city, location.province]
    .filter(Boolean)
    .join(', ');

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// ===================== LOCATION QUERIES =====================

/**
 * Get all active outlet locations
 * @param {Object} filters - Filter parameters
 * @returns {Promise<Array>} Array of locations
 */
async function getActiveOutlets(filters = {}) {
  const { brand_id, is_outlet = true } = filters;

  const whereClause = {
    is_active: true,
    is_outlet: is_outlet === true || is_outlet === undefined,
  };

  // Add brand filter if provided
  if (brand_id !== undefined) {
    whereClause.brand_id = Number(brand_id);
  }

  const locations = await prisma.location.findMany({
    where: whereClause,
    orderBy: [{ city: 'asc' }, { name: 'asc' }],
  });

  return locations;
}

/**
 * Get location by ID
 * @param {number} locationId - The location ID
 * @returns {Promise<Object|null>} The location or null if not found
 */
async function getLocationById(locationId) {
  const location = await prisma.location.findFirst({
    where: {
      id: Number(locationId),
      is_active: true,
    },
  });

  return location;
}

/**
 * Get locations by city
 * @param {string} city - The city name
 * @returns {Promise<Array>} Array of locations in the city
 */
async function getLocationsByCity(city) {
  const locations = await prisma.location.findMany({
    where: {
      city: city,
      is_active: true,
      is_outlet: true,
    },
    orderBy: [{ name: 'asc' }],
  });

  return locations;
}

/**
 * Get all cities that have active outlets
 * @returns {Promise<Array>} Array of unique city names
 */
async function getActiveCities() {
  const locations = await prisma.location.findMany({
    where: {
      is_active: true,
      is_outlet: true,
    },
    select: {
      city: true,
    },
    distinct: ['city'],
    orderBy: [{ city: 'asc' }],
  });

  return locations.map(loc => loc.city).filter(Boolean);
}

// ===================== LOCATION TRANSFORMATION =====================

/**
 * Transform database location to API response format
 * @param {Object} location - The location from database
 * @returns {Object} Formatted location for API response
 */
function formatLocationForAPI(location) {
  if (!location) return null;

  const latitude = decimalToNumber(location.latitude);
  const longitude = decimalToNumber(location.longitude);

  return {
    id: location.id,
    name: location.name,
    address: location.address,
    city: location.city,
    province: location.province,
    latitude,
    longitude,
    maps_url: buildMapsUrl(location),
    phone: location.phone,
    brand_id: location.brand_id,
  };
}

/**
 * Transform multiple locations to API response format
 * @param {Array} locations - Array of locations from database
 * @returns {Array} Formatted locations for API response
 */
function formatLocationsForAPI(locations) {
  return locations.map(formatLocationForAPI).filter(Boolean);
}

/**
 * Transform location to summary format (minimal data)
 * @param {Object} location - The location from database
 * @returns {Object} Formatted location summary
 */
function formatLocationSummary(location) {
  if (!location) return null;

  return {
    id: location.id,
    name: location.name,
    city: location.city,
    province: location.province,
  };
}

/**
 * Transform multiple locations to summary format
 * @param {Array} locations - Array of locations from database
 * @returns {Array} Formatted location summaries
 */
function formatLocationsSummary(locations) {
  return locations.map(formatLocationSummary).filter(Boolean);
}

// ===================== EXPORTS =====================

module.exports = {
  // Helper functions
  decimalToNumber,
  buildMapsUrl,

  // Location queries
  getActiveOutlets,
  getLocationById,
  getLocationsByCity,
  getActiveCities,

  // Location transformation
  formatLocationForAPI,
  formatLocationsForAPI,
  formatLocationSummary,
  formatLocationsSummary,
};