const prisma = require("../lib/prisma");

async function getCustomerPoints(req, res) {
  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
      include: {
        customer_point: true,
      },
    });

    if (!customer) {
      return res.status(404).json({
        message: "Customer tidak ditemukan",
      });
    }

    res.json({
      id: customer.id,
      name: customer.name,
      phone_number: customer.phone_number,
      available_point: customer.customer_point?.available_point ?? 0,
      total_point: customer.customer_point?.total_point ?? 0,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
}

module.exports = {
  getCustomerPoints,
};
