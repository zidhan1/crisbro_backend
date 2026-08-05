const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { respondWithServerError } = require('../lib/serverError');

function decimalToNumber(value) {
  if (value === null || value === undefined) return null;

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

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

// Endpoint untuk mengambil daftar lokasi outlet aktif
router.get('/', async (req, res) => {
  try {
    const locations = await prisma.location.findMany({
      where: { is_active: true, is_outlet: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    const result = locations.map((loc) => {
      const latitude = decimalToNumber(loc.latitude);
      const longitude = decimalToNumber(loc.longitude);

      return {
        id: loc.id,
        name: loc.name,
        address: loc.address,
        city: loc.city,
        province: loc.province,
        latitude,
        longitude,
        maps_url: buildMapsUrl(loc),
      };
    });

    res.json(result);
  } catch (error) {
    respondWithServerError(res, error, 'locationRoutes');
  }
});

module.exports = router;
