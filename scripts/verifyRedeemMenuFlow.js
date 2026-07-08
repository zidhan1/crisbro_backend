require('dotenv').config({ quiet: true });

process.env.JWT_SECRET ||= 'local-bug-001-verification-secret';

const bcrypt = require('bcrypt');
const app = require('../src/index');
const prisma = require('../src/lib/prisma');

const TEST_PHONE = '89900010001';
const TEST_PASSWORD = 'Bug001Test123';
const TEST_PREFIX = 'BUG001_E2E';
const POINTS_BEFORE = 1000;
const POINTS_REQUIRED = 250;
const CONFIRM_FLAG = '--confirm-db-write';
const CLEANUP_FLAG = '--cleanup';
const ALLOW_PRODUCTION_FLAG = '--allow-production-db';

function getDatabaseHost() {
  try {
    return new URL(process.env.DATABASE_URL).host;
  } catch {
    return 'unknown';
  }
}

function assertSafeExecution() {
  const hasConfirmFlag = process.argv.includes(CONFIRM_FLAG);
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const allowProduction = process.argv.includes(ALLOW_PRODUCTION_FLAG);

  if (!hasConfirmFlag) {
    throw new Error(
      `Script ini menulis/menghapus data test di database. Jalankan dengan ${CONFIRM_FLAG} jika sudah yakin DATABASE_URL benar.`,
    );
  }

  if (isProduction && !allowProduction) {
    throw new Error(
      `Refuse to run in production. Jika ini benar-benar DB test production-like, tambahkan ${ALLOW_PRODUCTION_FLAG}.`,
    );
  }
}

function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function cleanupPreviousRun() {
  const users = await prisma.user.findMany({
    where: { phone_number: TEST_PHONE },
    include: { customer: true },
  });
  const customerIds = users
    .map((user) => user.customer?.id)
    .filter((id) => Number.isInteger(id));
  const userIds = users.map((user) => user.id);

  const rewards = await prisma.rewardsCatalog.findMany({
    where: { name: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const rewardIds = rewards.map((reward) => reward.id);

  const redemptions = await prisma.rewardRedemption.findMany({
    where: {
      OR: [
        customerIds.length ? { customer_id: { in: customerIds } } : undefined,
        rewardIds.length ? { reward_id: { in: rewardIds } } : undefined,
      ].filter(Boolean),
    },
    select: { id: true },
  });
  const redemptionIds = redemptions.map((redemption) => redemption.id);

  await prisma.pointHistory.deleteMany({
    where: {
      OR: [
        customerIds.length ? { customer_id: { in: customerIds } } : undefined,
        redemptionIds.length
          ? { reward_redemption_id: { in: redemptionIds } }
          : undefined,
      ].filter(Boolean),
    },
  });
  await prisma.rewardRedemption.deleteMany({
    where: { id: { in: redemptionIds } },
  });
  await prisma.session.deleteMany({ where: { user_id: { in: userIds } } });
  await prisma.customerPoint.deleteMany({
    where: { customer_id: { in: customerIds } },
  });
  await prisma.customerLocation.deleteMany({
    where: { customer_id: { in: customerIds } },
  });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.redeemMenuItem.deleteMany({
    where: { menu_item: { name: { startsWith: TEST_PREFIX } } },
  });
  await prisma.menuItem.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
  await prisma.redeemMenuCategory.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
  await prisma.menuCategory.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
  await prisma.rewardsCatalog.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
  await prisma.brand.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
}

async function seedRedeemScenario() {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  return prisma.$transaction(async (tx) => {
    const brand = await tx.brand.create({
      data: { name: `${TEST_PREFIX} Brand` },
    });

    const menuCategory = await tx.menuCategory.create({
      data: {
        brand_id: brand.id,
        name: `${TEST_PREFIX} Menu Category`,
        is_active: true,
      },
    });

    const menuItem = await tx.menuItem.create({
      data: {
        brand_id: brand.id,
        category_id: menuCategory.id,
        name: `${TEST_PREFIX} Chicken Katsu`,
        description: 'Menu test untuk verifikasi BUG-001',
        price: 25000,
        image_url: '',
        is_active: true,
      },
    });

    const redeemCategory = await tx.redeemMenuCategory.create({
      data: {
        name: `${TEST_PREFIX} Redeem Category`,
        is_active: true,
      },
    });

    const redeemMenuItem = await tx.redeemMenuItem.create({
      data: {
        menu_item_id: menuItem.id,
        category_id: redeemCategory.id,
        points_required: POINTS_REQUIRED,
        is_active: true,
      },
    });

    const user = await tx.user.create({
      data: {
        phone_number: TEST_PHONE,
        password_hash: passwordHash,
        role: 'customer',
        customer: {
          create: {
            runchise_id: 990010001,
            name: `${TEST_PREFIX} Customer`,
            phone_number: TEST_PHONE,
            status: 'active',
            balance: 0,
            brand_id: brand.id,
            customer_point: {
              create: {
                total_point: POINTS_BEFORE,
                available_point: POINTS_BEFORE,
                next_reward_threshold: 2000,
              },
            },
          },
        },
      },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    return { brand, menuItem, redeemMenuItem, user };
  });
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);

  return { response, body };
}

async function run() {
  assertSafeExecution();

  console.log('BUG-001 E2E database target:', getDatabaseHost());
  await cleanupPreviousRun();

  if (process.argv.includes(CLEANUP_FLAG)) {
    console.log('BUG-001 E2E cleanup completed');
    return;
  }

  const seeded = await seedRedeemScenario();

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const catalog = await requestJson(baseUrl, '/api/catalog/redeem-menu');
    assertCondition(catalog.response.ok, 'Gagal mengambil katalog redeem menu', {
      status: catalog.response.status,
      body: catalog.body,
    });
    assertCondition(
      Array.isArray(catalog.body) &&
        catalog.body.some((item) => item.id === seeded.redeemMenuItem.id),
      'Item redeem test tidak muncul di katalog publik',
      { redeemMenuItemId: seeded.redeemMenuItem.id, body: catalog.body },
    );

    const login = await requestJson(baseUrl, '/api/login', {
      method: 'POST',
      body: JSON.stringify({
        phone_number: TEST_PHONE,
        password: TEST_PASSWORD,
      }),
    });
    assertCondition(login.response.ok, 'Login customer test gagal', {
      status: login.response.status,
      body: login.body,
    });
    assertCondition(
      typeof login.body?.token === 'string' && login.body.token.length > 0,
      'Login tidak mengembalikan token valid',
      { body: login.body },
    );

    const redeem = await requestJson(
      baseUrl,
      `/api/redeem/menu/${seeded.redeemMenuItem.id}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${login.body.token}` },
      },
    );
    assertCondition(redeem.response.status === 410, 'Redeem menu customer harus dinonaktifkan', {
      status: redeem.response.status,
      body: redeem.body,
    });

    const legacyRedeem = await requestJson(baseUrl, '/api/redeem/1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assertCondition(
      legacyRedeem.response.status === 410,
      'Redeem reward legacy customer harus dinonaktifkan',
      {
        status: legacyRedeem.response.status,
        body: legacyRedeem.body,
      },
    );

    const [updatedPoint, redemption, pointHistory] = await Promise.all([
      prisma.customerPoint.findUnique({
        where: { customer_id: seeded.user.customer.id },
      }),
      prisma.rewardRedemption.findFirst({
        where: { customer_id: seeded.user.customer.id },
      }),
      prisma.pointHistory.findFirst({
        where: {
          customer_id: seeded.user.customer.id,
          type: 'redeem',
        },
      }),
    ]);

    assertCondition(
      updatedPoint?.available_point === POINTS_BEFORE,
      'CustomerPoint.available_point tidak boleh berkurang dari estimasi customer',
      { updatedPoint },
    );
    assertCondition(
      redemption === null,
      'Aplikasi customer tidak boleh membuat RewardRedemption',
      { redemption },
    );
    assertCondition(
      pointHistory === null,
      'Aplikasi customer tidak boleh membuat PointHistory redeem',
      { pointHistory },
    );

    console.log('Redeem menu estimation flow verification passed');
    console.log({
      baseUrl,
      testPhone: TEST_PHONE,
      testPassword: TEST_PASSWORD,
      redeemMenuItemId: seeded.redeemMenuItem.id,
      pointsBefore: POINTS_BEFORE,
      estimatedPointsSpent: POINTS_REQUIRED,
      pointsAfterApiAttempt: updatedPoint.available_point,
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

run()
  .catch((error) => {
    console.error('BUG-001 E2E verification failed');
    console.error(error.message);
    if (error.details) console.error(error.details);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
