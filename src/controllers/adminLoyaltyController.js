const prisma = require('../lib/prisma');
const bcrypt = require('bcrypt');

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

function normalizePhone(raw) {
  const phone = parseOptionalString(raw, 'phone_number', 30);
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function parseAdminUserRole(value) {
  const role = parseRequiredString(value ?? 'marketing', 'role', 30);
  const allowedRoles = new Set(['admin', 'staff', 'marketing']);

  if (!allowedRoles.has(role)) {
    throw new Error('role harus admin, staff, atau marketing');
  }

  return role;
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

function parseOptionalNumber(value, fieldName, { min = 0 } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const number = Number(value);
  if (Number.isNaN(number) || number < min) {
    throw new Error(`${fieldName} harus berupa angka minimal ${min}`);
  }

  return number;
}

function parseCustomerStatus(value) {
  const status = parseOptionalString(value ?? 'active', 'status', 30) ?? 'active';
  const allowed = new Set(['active', 'inactive']);

  if (!allowed.has(status)) {
    throw new Error('status harus active atau inactive');
  }

  return status;
}

function parseCustomerGender(value) {
  const gender = parseOptionalString(value ?? 'unknown', 'gender', 30) ?? 'unknown';
  const allowed = new Set(['male', 'female', 'unknown']);

  if (!allowed.has(gender)) {
    throw new Error('gender harus male, female, atau unknown');
  }

  return gender;
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

  if (error.code === 'P2025') {
    return res.status(404).json({ message: 'Data tidak ditemukan' });
  }

  return res.status(500).json({ error: error.message });
}

async function listAdminUsers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);

    const users = await prisma.user.findMany({
      where: {
        role: { in: ['admin', 'staff', 'marketing'] },
        ...(search && {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { phone_number: { contains: search } },
            { role: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: [{ role: 'asc' }, { created_at: 'desc' }],
    });

    res.json(users);
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminUser(req, res) {
  try {
    const email = parseOptionalString(req.body.email, 'email', 255);
    const phone_number = normalizePhone(req.body.phone_number);
    const password = parseRequiredString(req.body.password, 'password', 255);
    const role = parseAdminUserRole(req.body.role);

    if (!email && !phone_number) {
      return badRequest(res, 'Email atau nomor telepon wajib diisi');
    }

    if (password.length < 6) {
      return badRequest(res, 'Password minimal 6 karakter');
    }

    const password_hash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        phone_number,
        password_hash,
        role,
      },
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
    });

    res.status(201).json(user);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminUser(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};

    if (req.body.email !== undefined) data.email = parseOptionalString(req.body.email, 'email', 255);
    if (req.body.phone_number !== undefined) data.phone_number = normalizePhone(req.body.phone_number);
    if (req.body.role !== undefined) data.role = parseAdminUserRole(req.body.role);

    if (req.body.password !== undefined && req.body.password !== '') {
      const password = parseRequiredString(req.body.password, 'password', 255);
      if (password.length < 6) {
        return badRequest(res, 'Password minimal 6 karakter');
      }
      data.password_hash = await bcrypt.hash(password, 10);
    }

    if (Object.keys(data).length === 0) {
      return badRequest(res, 'Tidak ada data yang diubah');
    }

    if (data.role && id === req.user.id && data.role !== 'admin') {
      return badRequest(res, 'Admin tidak dapat mengubah role akun sendiri');
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
    });

    res.json(user);
  } catch (error) {
    handleError(res, error);
  }
}

async function deleteAdminUser(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');

    if (id === req.user.id) {
      return badRequest(res, 'Admin tidak dapat menghapus akun sendiri');
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { customer: { select: { id: true } } },
    });

    if (!user) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    if (user.customer) {
      return badRequest(res, 'User customer tidak dapat dihapus dari menu admin ini');
    }

    await prisma.$transaction([
      prisma.session.deleteMany({ where: { user_id: id } }),
      prisma.user.delete({ where: { id } }),
    ]);

    res.json({ message: 'User berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminCustomers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(parsePositiveInt(req.query.limit ?? 20, 'limit'), 100);
    const skip = (page - 1) * limit;
    const where = {
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone_number: { contains: search } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
          { owner_location: { name: { contains: search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, phone_number: true, role: true } },
          brand: { select: { id: true, name: true } },
          owner_location: { select: { id: true, name: true, city: true } },
          customer_point: true,
        },
        orderBy: { updated_at: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    res.json({
      items: customers,
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminCustomer(req, res) {
  try {
    const name = parseRequiredString(req.body.name, 'name', 120);
    const phone_number = normalizePhone(req.body.phone_number);
    const email = parseOptionalString(req.body.email, 'email', 255);
    const brand_id = parsePositiveInt(req.body.brand_id ?? 1, 'brand_id');
    const owner_location_id = parsePositiveInt(req.body.owner_location_id, 'owner_location_id', {
      required: false,
    });
    const total_point = parseNonNegativeInt(req.body.total_point ?? 0, 'total_point');
    const available_point = parseNonNegativeInt(req.body.available_point ?? total_point, 'available_point');

    if (!phone_number) {
      return badRequest(res, 'Nomor telepon wajib diisi');
    }

    const customer = await prisma.$transaction(async (tx) => {
      await tx.brand.upsert({
        where: { id: brand_id },
        update: {},
        create: { id: brand_id, name: `Brand ${brand_id}` },
      });

      const user = await tx.user.create({
        data: {
          email,
          phone_number,
          password_hash: '',
          role: 'customer',
        },
      });

      return tx.customer.create({
        data: {
          user_id: user.id,
          name,
          phone_number,
          phone_number_country_code: parsePositiveInt(
            req.body.phone_number_country_code ?? 62,
            'phone_number_country_code',
          ),
          address: parseOptionalString(req.body.address, 'address', 1000),
          province: parseOptionalString(req.body.province, 'province', 120),
          city: parseOptionalString(req.body.city, 'city', 120),
          country: parseOptionalString(req.body.country ?? 'Indonesia', 'country', 120),
          postal_code: parseOptionalString(req.body.postal_code, 'postal_code', 20),
          dob: parseOptionalDate(req.body.dob, 'dob'),
          gender: parseCustomerGender(req.body.gender),
          status: parseCustomerStatus(req.body.status),
          balance: parseOptionalNumber(req.body.balance ?? 0, 'balance') ?? 0,
          brand_id,
          owner_location_id,
          created_by_id: req.user.id,
          last_updated_by_id: req.user.id,
          customer_point: {
            create: {
              total_point,
              available_point,
              next_reward_threshold: parsePositiveInt(
                req.body.next_reward_threshold ?? 2000,
                'next_reward_threshold',
              ),
            },
          },
        },
        include: {
          user: { select: { id: true, email: true, phone_number: true, role: true } },
          brand: { select: { id: true, name: true } },
          owner_location: { select: { id: true, name: true, city: true } },
          customer_point: true,
        },
      });
    });

    res.status(201).json(customer);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};
    const userData = {};
    const pointData = {};

    if (req.body.name !== undefined) data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.phone_number !== undefined) {
      data.phone_number = normalizePhone(req.body.phone_number);
      userData.phone_number = data.phone_number;
    }
    if (req.body.email !== undefined) userData.email = parseOptionalString(req.body.email, 'email', 255);
    if (req.body.phone_number_country_code !== undefined) {
      data.phone_number_country_code = parsePositiveInt(
        req.body.phone_number_country_code,
        'phone_number_country_code',
      );
    }
    if (req.body.address !== undefined) data.address = parseOptionalString(req.body.address, 'address', 1000);
    if (req.body.province !== undefined) data.province = parseOptionalString(req.body.province, 'province', 120);
    if (req.body.city !== undefined) data.city = parseOptionalString(req.body.city, 'city', 120);
    if (req.body.country !== undefined) data.country = parseOptionalString(req.body.country, 'country', 120);
    if (req.body.postal_code !== undefined) data.postal_code = parseOptionalString(req.body.postal_code, 'postal_code', 20);
    if (req.body.dob !== undefined) data.dob = parseOptionalDate(req.body.dob, 'dob');
    if (req.body.gender !== undefined) data.gender = parseCustomerGender(req.body.gender);
    if (req.body.status !== undefined) data.status = parseCustomerStatus(req.body.status);
    if (req.body.balance !== undefined) data.balance = parseOptionalNumber(req.body.balance, 'balance') ?? 0;
    if (req.body.brand_id !== undefined) data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.owner_location_id !== undefined) {
      data.owner_location_id = parsePositiveInt(req.body.owner_location_id, 'owner_location_id', {
        required: false,
      }) ?? null;
    }
    if (req.body.total_point !== undefined) {
      pointData.total_point = parseNonNegativeInt(req.body.total_point, 'total_point');
    }
    if (req.body.available_point !== undefined) {
      pointData.available_point = parseNonNegativeInt(req.body.available_point, 'available_point');
    }
    if (req.body.next_reward_threshold !== undefined) {
      pointData.next_reward_threshold = parsePositiveInt(
        req.body.next_reward_threshold,
        'next_reward_threshold',
      );
    }

    data.last_updated_by_id = req.user.id;

    const customer = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({
        where: { id },
        select: { user_id: true },
      });

      if (!existing) {
        throw Object.assign(new Error('Customer tidak ditemukan'), { code: 'P2025' });
      }

      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: existing.user_id }, data: userData });
      }

      if (Object.keys(pointData).length > 0) {
        await tx.customerPoint.upsert({
          where: { customer_id: id },
          update: pointData,
          create: {
            customer_id: id,
            total_point: pointData.total_point ?? 0,
            available_point: pointData.available_point ?? 0,
            next_reward_threshold: pointData.next_reward_threshold ?? 2000,
          },
        });
      }

      return tx.customer.update({
        where: { id },
        data,
        include: {
          user: { select: { id: true, email: true, phone_number: true, role: true } },
          brand: { select: { id: true, name: true } },
          owner_location: { select: { id: true, name: true, city: true } },
          customer_point: true,
        },
      });
    });

    res.json(customer);
  } catch (error) {
    handleError(res, error);
  }
}

async function deleteAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { user_id: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    await prisma.$transaction([
      prisma.pointHistory.deleteMany({ where: { customer_id: id } }),
      prisma.rewardRedemption.deleteMany({ where: { customer_id: id } }),
      prisma.customerPoint.deleteMany({ where: { customer_id: id } }),
      prisma.customerLocation.deleteMany({ where: { customer_id: id } }),
      prisma.customer.delete({ where: { id } }),
      prisma.session.deleteMany({ where: { user_id: customer.user_id } }),
      prisma.user.delete({ where: { id: customer.user_id } }),
    ]);

    res.json({ message: 'Customer berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminBrands(req, res) {
  try {
    const brands = await prisma.brand.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    res.json(brands);
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminLocations(req, res) {
  try {
    const locations = await prisma.location.findMany({
      where: { is_active: true, is_outlet: true },
      select: { id: true, name: true, city: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    res.json(locations);
  } catch (error) {
    handleError(res, error);
  }
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
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  listAdminCustomers,
  createAdminCustomer,
  updateAdminCustomer,
  deleteAdminCustomer,
  listAdminBrands,
  listAdminLocations,
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
