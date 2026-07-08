const prisma = require('../lib/prisma');

async function getMyPointHistory(req, res) {
  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
      select: { id: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    const where = { customer_id: customer.id };
    const [total, histories] = await prisma.$transaction([
      prisma.pointHistory.count({ where }),
      prisma.pointHistory.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: 50,
        include: {
          reward_redemption: {
            select: {
              id: true,
              status: true,
              reward: {
                select: {
                  name: true,
                  image_url: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return res.json({
      total,
      items: histories.map((history) => ({
        id: history.id,
        points_change: history.points_change,
        type: history.type,
        description: history.description,
        created_at: history.created_at,
        redemption: history.reward_redemption
          ? {
              id: history.reward_redemption.id,
              status: history.reward_redemption.status,
              reward: history.reward_redemption.reward,
            }
          : null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

module.exports = { getMyPointHistory };
