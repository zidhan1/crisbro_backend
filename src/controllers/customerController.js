const prisma = require('../lib/prisma');

// Mengambil data poin customer yang sedang login
async function getCustomerPoints(req, res) {
  try {
    // Mencari data customer beserta informasi poin berdasarkan user yang login
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
      include: {
        customer_point: true,
      },
    });

    // Jika data customer tidak ditemukan
    if (!customer) {
      return res.status(404).json({
        message: 'Customer tidak ditemukan',
      });
    }

    // Mengirim data customer beserta total dan poin yang tersedia
    res.json({
      id: customer.id,
      name: customer.name,
      phone_number: customer.phone_number,
      available_point: customer.customer_point?.available_point ?? 0,
      total_point: customer.customer_point?.total_point ?? 0,
    });
  } catch (error) {
    // Menangani error saat mengambil data
    res.status(500).json({
      error: error.message,
    });
  }
}

// Mengekspor fungsi agar dapat digunakan pada file route
module.exports = {
  getCustomerPoints,
};
