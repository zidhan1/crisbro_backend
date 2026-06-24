const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// Endpoint untuk mengambil daftar lokasi outlet aktif
router.get('/', async (req, res) => {
  try {
    // Mengambil data lokasi yang aktif dan berstatus outlet
    const locations = await prisma.location.findMany({
      where: { is_active: true, is_outlet: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    // Memformat data sebelum dikirim ke frontend
    const result = locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      address: loc.address,
      city: loc.city,
      phone: loc.phone ?? null,
      hours: '10.00 – 22.00', // jam operasional statis
    }));

    // Mengirim hasil ke client
    res.json(result);
  } catch (error) {
    // Menangani error server
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
