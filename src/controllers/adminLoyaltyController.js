const prisma = require('../lib/prisma');

function badRequest(res, message) {
  return res.status(400).json({ message });
}

function parsePositiveInt(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new Error(`${fieldName} wajib diisi`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} harus berupa integer positif`);
  }

  return number;
}

function parseNonNegativeInt(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new Error(`${fieldName} wajib diisi`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} harus berupa integer non-negatif`);
  }

  return number;
}

function parseBoolean(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new Error(`${fieldName} wajib diisi`);
  }

  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(`${fieldName} harus berupa boolean`);
}

function parseOptionalString(value, fieldName, maxLength = 255) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} harus berupa string`);

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} maksimal ${maxLength} karakter`);
  }

  return trimmed || null;
}

function parseRequiredString(value, fieldName, maxLength = 255) {
  const parsed = parseOptionalString(value, fieldName, maxLength);
  if (!parsed) throw new Error(`${fieldName} wajib diisi`);
  return parsed;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} harus berupa tanggal valid`);
  }

  return date;
}

function handleError(res, error) {
  if (error.message?.includes('harus') || error.message?.includes('wajib')) {
    return badRequest(res, error.message);
  }

  if (error.code === 'P2002') {
    return res.status(409).json({ message: 'Data duplikat' });
  }

  if (error.code === 'P2003') {
    return badRequest(res, 'Referensi data tidak valid');
  }

  return res.status(500).json({ error: error.message });
}

async function getSummary(req, res) {
  try {
    const [
      totalMembers,
      activeMembers,
      points,
      pointsEarned,
      pointsRedeemed,
      redemptionCount,
      pendingRedemptions,
      claimedRedemptions,
      topRewards,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.customer.count({ where: { status: 'active' } }),
      prisma.customerPoint.aggregate({
        _sum: { total_point: true, available_point: true },
      }),
      prisma.pointHistory.aggregate({
        where: { points_change: { gt: 0 } },
        _sum: { points_change: true },
      }),
      prisma.pointHistory.aggregate({
        where: { points_change: { lt: 0 } },
        _sum: { points_change: true },
      }),
      prisma.rewardRedemption.count(),
      prisma.rewardRedemption.count({ where: { status: 'pending' } }),
      prisma.rewardRedemption.count({ where: { status: 'claimed' } }),
      prisma.rewardRedemption.groupBy({
        by: ['reward_id'],
        _count: { reward_id: true },
        _sum: { points_spent: true },
        orderBy: { _count: { reward_id: 'desc' } },
        take: 5,
      }),
    ]);

    const rewardIds = topRewards.map((item) => item.reward_id);
    const rewards = await prisma.rewardsCatalog.findMany({
      where: { id: { in: rewardIds } },
      select: { id: true, name: true },
    });
    const rewardById = new Map(rewards.map((reward) => [reward.id, reward]));

    res.json({
      total_members: totalMembers,
      active_members: activeMembers,
      total_points_given: points._sum.total_point ?? 0,
      total_points_available: points._sum.available_point ?? 0,
      points_earned: pointsEarned._sum.points_change ?? 0,
      points_redeemed: Math.abs(pointsRedeemed._sum.points_change ?? 0),
      redemption_count: redemptionCount,
      pending_redemptions: pendingRedemptions,
      claimed_redemptions: claimedRedemptions,
      top_rewards: topRewards.map((item) => ({
        reward_id: item.reward_id,
        reward_name: rewardById.get(item.reward_id)?.name ?? 'Reward',
        redemption_count: item._count.reward_id,
        points_spent: item._sum.points_spent ?? 0,
      })),
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function listRewards(req, res) {
  try {
    const rewards = await prisma.rewardsCatalog.findMany({
      include: { brand: { select: { id: true, name: true } } },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
    });

    res.json(rewards);
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
        description: parseOptionalString(req.body.description, 'description', 1000),
        points_required: parsePositiveInt(req.body.points_required, 'points_required'),
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

    if (req.body.brand_id !== undefined) data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.name !== undefined) data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.description !== undefined) data.description = parseOptionalString(req.body.description, 'description', 1000);
    if (req.body.points_required !== undefined) data.points_required = parsePositiveInt(req.body.points_required, 'points_required');
    if (req.body.image_url !== undefined) data.image_url = parseOptionalString(req.body.image_url, 'image_url', 1000);
    if (req.body.is_active !== undefined) data.is_active = parseBoolean(req.body.is_active, 'is_active');

    const reward = await prisma.rewardsCatalog.update({ where: { id }, data });
    res.json(reward);
  } catch (error) {
    handleError(res, error);
  }
}

async function listCatalogMenuItems(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);

    const items = await prisma.menuItem.findMany({
      where: {
        is_active: true,
        ...(search && {
          name: { contains: search, mode: 'insensitive' },
        }),
      },
      include: {
        category: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
      take: limit,
    });

    res.json(items);
  } catch (error) {
    handleError(res, error);
  }
}

async function listRedeemCategories(req, res) {
  try {
    const categories = await prisma.redeemMenuCategory.findMany({
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });
    res.json(categories);
  } catch (error) {
    handleError(res, error);
  }
}

async function createRedeemCategory(req, res) {
  try {
    const category = await prisma.redeemMenuCategory.create({
      data: {
        name: parseRequiredString(req.body.name, 'name', 80),
        sort_order: parseNonNegativeInt(req.body.sort_order ?? 0, 'sort_order'),
        is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
      },
    });
    res.status(201).json(category);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateRedeemCategory(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.name !== undefined) data.name = parseRequiredString(req.body.name, 'name', 80);
    if (req.body.sort_order !== undefined) data.sort_order = parseNonNegativeInt(req.body.sort_order, 'sort_order');
    if (req.body.is_active !== undefined) data.is_active = parseBoolean(req.body.is_active, 'is_active');

    const category = await prisma.redeemMenuCategory.update({ where: { id }, data });
    res.json(category);
  } catch (error) {
    handleError(res, error);
  }
}

async function listRedeemItems(req, res) {
  try {
    const items = await prisma.redeemMenuItem.findMany({
      include: {
        category: true,
        menu_item: {
          include: { category: { select: { id: true, name: true } } },
        },
      },
      orderBy: [
        { category: { sort_order: 'asc' } },
        { sort_order: 'asc' },
        { id: 'asc' },
      ],
    });

    res.json(items);
  } catch (error) {
    handleError(res, error);
  }
}

async function createRedeemItem(req, res) {
  try {
    const item = await prisma.redeemMenuItem.create({
      data: {
        menu_item_id: parsePositiveInt(req.body.menu_item_id, 'menu_item_id'),
        category_id: parsePositiveInt(req.body.category_id, 'category_id'),
        points_required: parsePositiveInt(req.body.points_required, 'points_required'),
        is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
        badge: parseOptionalString(req.body.badge, 'badge', 40),
        sort_order: parseNonNegativeInt(req.body.sort_order ?? 0, 'sort_order'),
        start_at: parseOptionalDate(req.body.start_at, 'start_at'),
        end_at: parseOptionalDate(req.body.end_at, 'end_at'),
        stock_limit: parsePositiveInt(req.body.stock_limit, 'stock_limit', { required: false }),
        daily_limit: parsePositiveInt(req.body.daily_limit, 'daily_limit', { required: false }),
      },
      include: {
        category: true,
        menu_item: { include: { category: { select: { id: true, name: true } } } },
      },
    });

    res.status(201).json(item);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateRedeemItem(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.menu_item_id !== undefined) data.menu_item_id = parsePositiveInt(req.body.menu_item_id, 'menu_item_id');
    if (req.body.category_id !== undefined) data.category_id = parsePositiveInt(req.body.category_id, 'category_id');
    if (req.body.points_required !== undefined) data.points_required = parsePositiveInt(req.body.points_required, 'points_required');
    if (req.body.is_active !== undefined) data.is_active = parseBoolean(req.body.is_active, 'is_active');
    if (req.body.badge !== undefined) data.badge = parseOptionalString(req.body.badge, 'badge', 40);
    if (req.body.sort_order !== undefined) data.sort_order = parseNonNegativeInt(req.body.sort_order, 'sort_order');
    if (req.body.start_at !== undefined) data.start_at = parseOptionalDate(req.body.start_at, 'start_at');
    if (req.body.end_at !== undefined) data.end_at = parseOptionalDate(req.body.end_at, 'end_at');
    if (req.body.stock_limit !== undefined) data.stock_limit = parsePositiveInt(req.body.stock_limit, 'stock_limit', { required: false });
    if (req.body.daily_limit !== undefined) data.daily_limit = parsePositiveInt(req.body.daily_limit, 'daily_limit', { required: false });

    const item = await prisma.redeemMenuItem.update({
      where: { id },
      data,
      include: {
        category: true,
        menu_item: { include: { category: { select: { id: true, name: true } } } },
      },
    });

    res.json(item);
  } catch (error) {
    handleError(res, error);
  }
}

async function listRedemptions(req, res) {
  try {
    const status = parseOptionalString(req.query.status, 'status', 30);
    const redemptions = await prisma.rewardRedemption.findMany({
      where: status ? { status } : {},
      include: {
        reward: { select: { id: true, name: true, points_required: true } },
        customer: {
          select: {
            id: true,
            name: true,
            phone_number: true,
            user: { select: { phone_number: true, email: true } },
          },
        },
      },
      orderBy: { id: 'desc' },
      take: 200,
    });

    res.json(redemptions);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateRedemptionStatus(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const status = parseRequiredString(req.body.status, 'status', 30);
    const allowed = new Set(['pending', 'claimed', 'expired']);

    if (!allowed.has(status)) {
      return badRequest(res, 'status tidak valid');
    }

    const redemption = await prisma.rewardRedemption.update({
      where: { id },
      data: {
        status,
        redeemed_at: status === 'claimed' ? new Date() : null,
      },
      include: {
        reward: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, phone_number: true } },
      },
    });

    res.json(redemption);
  } catch (error) {
    handleError(res, error);
  }
}

module.exports = {
  getSummary,
  listRewards,
  createReward,
  updateReward,
  listCatalogMenuItems,
  listRedeemCategories,
  createRedeemCategory,
  updateRedeemCategory,
  listRedeemItems,
  createRedeemItem,
  updateRedeemItem,
  listRedemptions,
  updateRedemptionStatus,
};
