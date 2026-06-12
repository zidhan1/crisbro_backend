const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

router.get('/', async (req, res) => {
  try {
    const locations = await prisma.location.findMany({
      where: { is_active: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    const result = locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      address: loc.address,
      city: loc.city,
      phone: loc.phone ?? null,
      hours: "10.00 – 22.00",
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;