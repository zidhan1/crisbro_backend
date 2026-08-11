const prisma = require('../../lib/prisma');
const {
  handleError,
  parseBoolean,
  parseOptionalString,
  parsePositiveInt,
  parseRequiredString,
} = require('./adminLoyaltyShared');

// L-7: katalog rewards dipisah dari controller raksasa. Isi fungsi dipindahkan
// apa adanya, termasuk paginasi M-8.

async function listRewards(req, res) {
  try {
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);
    const total = await prisma.rewardsCatalog.count();
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const rewards = await prisma.rewardsCatalog.findMany({
      include: { brand: { select: { id: true, name: true } } },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
      skip: (clampedPage - 1) * limit,
      take: limit,
    });

    res.json({ items: rewards, page: clampedPage, limit, total, total_pages: totalPages });
  } catch (error) {
    handleError(res, error);
  }
}

async function createReward(req, res) {
  try {
    const reward = await prisma.rewardsCatalog.create({
      data: {
        brand_id: parsePositiveInt(req.body.brand_id ?? 1, 'brand_id'),
        name: parseRequiredString(req.body.name, 'name', 120),
        description: parseOptionalString(
          req.body.description,
          'description',
          1000,
        ),
        points_required: parsePositiveInt(
          req.body.points_required,
          'points_required',
        ),
        image_url: parseOptionalString(req.body.image_url, 'image_url', 1000),
        is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
      },
    });

    res.status(201).json(reward);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateReward(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.brand_id !== undefined)
      data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.name !== undefined)
      data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.description !== undefined)
      data.description = parseOptionalString(
        req.body.description,
        'description',
        1000,
      );
    if (req.body.points_required !== undefined)
      data.points_required = parsePositiveInt(
        req.body.points_required,
        'points_required',
      );
    if (req.body.image_url !== undefined)
      data.image_url = parseOptionalString(
        req.body.image_url,
        'image_url',
        1000,
      );
    if (req.body.is_active !== undefined)
      data.is_active = parseBoolean(req.body.is_active, 'is_active');

    const reward = await prisma.rewardsCatalog.update({ where: { id }, data });
    res.json(reward);
  } catch (error) {
    handleError(res, error);
  }
}

module.exports = {
  listRewards,
  createReward,
  updateReward,
};
