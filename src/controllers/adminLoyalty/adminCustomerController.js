const prisma = require('../../lib/prisma');
const { Prisma } = require('@prisma/client');
const { recordAdminActivity } = require('../../services/adminActivityLogService');
const {
  syncCustomerToRunchise,
} = require('../../services/runchiseCustomerSyncService');
const { ValidationError } = require('../../lib/validationError');
const {
  DEFAULT_REWARD_THRESHOLD,
  badRequest,
  getActualCustomerChangedFields,
  getAdminCustomerInclude,
  getCustomerAuditSnapshot,
  getDefaultRewardThreshold,
  handleError,
  normalizePhone,
  parseCustomerGender,
  parseCustomerStatus,
  parseDateBoundary,
  parseLocationIds,
  parseOptionalDate,
  parseOptionalEmail,
  parseOptionalString,
  parsePositiveInt,
  parseRequiredString,
  parseSortOrder,
  sendCustomerActivationLink,
} = require('./adminLoyaltyShared');

// L-7: domain customer (daftar, CRUD, penyesuaian poin H-1/M-6, aktivasi ulang,
// retry sync, penghapusan M-7) dipisah dari controller raksasa. Isi fungsi
// dipindahkan apa adanya.

// Dashboard membaca tabel canonical Customer. Importer selektif sengaja tidak
// menyimpan ulang payload ke tabel staging agar penggunaan disk tetap kecil.
// Pagination, filter, dan sorting tetap dikerjakan PostgreSQL; Prisma hanya
// memuat maksimal satu halaman beserta relasi yang diperlukan UI.
async function listAdminCustomers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const sortBy = parseOptionalString(req.query.sort_by, 'sort_by', 50);
    const sortOrder = parseOptionalString(
      req.query.sort_order,
      'sort_order',
      10,
    );
    const from = parseDateBoundary(req.query.from, 'from');
    const to = parseDateBoundary(req.query.to, 'to', true);
    if (from && to && from > to) {
      return badRequest(res, 'from tidak boleh melebihi to');
    }

    // Tautan aktivasi akun hanya bisa dikirim lewat email, sehingga customer
    // tanpa email tidak akan pernah bisa mengaktifkan akunnya. Filter ini
    // dipakai petugas outlet untuk memunculkan daftar siapa saja yang emailnya
    // masih perlu dikumpulkan.
    const emailStatus =
      parseOptionalString(req.query.email_status, 'email_status', 20) ?? 'all';
    if (!['all', 'missing', 'present'].includes(emailStatus)) {
      return badRequest(
        res,
        'email_status hanya boleh all, missing, atau present',
      );
    }

    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 20, 'limit'),
      100,
    );
    const filters = [];
    // String kosong diperlakukan sama dengan NULL: keduanya berarti tidak ada
    // alamat yang bisa dikirimi tautan aktivasi.
    if (emailStatus === 'missing') {
      filters.push(
        Prisma.sql`(customer_user."email" IS NULL OR customer_user."email" = '')`,
      );
    } else if (emailStatus === 'present') {
      filters.push(
        Prisma.sql`(customer_user."email" IS NOT NULL AND customer_user."email" <> '')`,
      );
    }
    if (search) {
      const pattern = `%${search}%`;
      filters.push(Prisma.sql`(
        customer."name" ILIKE ${pattern}
        OR customer."phone_number" ILIKE ${pattern}
        OR customer_user."email" ILIKE ${pattern}
        OR customer."runchise_id"::text ILIKE ${pattern}
        OR EXISTS (
          SELECT 1
          FROM "CustomerLocation" search_customer_location
          JOIN "Location" search_location
            ON search_location."id" = search_customer_location."location_id"
          WHERE search_customer_location."customer_id" = customer."id"
            AND search_location."name" ILIKE ${pattern}
        )
      )`);
    }
    if (from) {
      filters.push(
        Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at") >= ${from}`,
      );
    }
    if (to) {
      filters.push(
        Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at") <= ${to}`,
      );
    }
    const filterSql = filters.length
      ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
      : Prisma.empty;

    const [countRow] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total,
        MIN(COALESCE(customer."runchise_created_at", customer."created_at")) AS earliest,
        MAX(COALESCE(customer."runchise_created_at", customer."created_at")) AS latest
      FROM "Customer" customer
      JOIN "User" customer_user ON customer_user."id" = customer."user_id"
      ${filterSql}
    `;
    const total = countRow?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const skip = (clampedPage - 1) * limit;
    const order = parseSortOrder(
      sortOrder,
      sortBy === 'created_at' || sortBy === 'updated_at' ? 'desc' : 'asc',
    );
    const direction = order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const orderColumns = {
      name: Prisma.sql`customer."name"`,
      email: Prisma.sql`customer_user."email"`,
      phone_number: Prisma.sql`customer."phone_number"`,
      outlet: Prisma.sql`(
        SELECT MIN(sort_location."name")
        FROM "CustomerLocation" sort_customer_location
        JOIN "Location" sort_location
          ON sort_location."id" = sort_customer_location."location_id"
        WHERE sort_customer_location."customer_id" = customer."id"
      )`,
      points: Prisma.sql`COALESCE(customer_point."available_point", 0)`,
      status: Prisma.sql`customer."status"`,
      activation_status: Prisma.sql`customer_user."activation_status"`,
      runchise_sync_status: Prisma.sql`customer."runchise_sync_status"`,
      created_at: Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at")`,
      updated_at: Prisma.sql`COALESCE(customer."runchise_updated_at", customer."updated_at")`,
    };
    const orderColumn =
      orderColumns[sortBy] ??
      Prisma.sql`COALESCE(customer."runchise_created_at", customer."created_at")`;

    const pageRows = await prisma.$queryRaw`
      SELECT customer."id"
      FROM "Customer" customer
      JOIN "User" customer_user ON customer_user."id" = customer."user_id"
      LEFT JOIN "CustomerPoint" customer_point
        ON customer_point."customer_id" = customer."id"
      ${filterSql}
      ORDER BY ${orderColumn} ${direction} NULLS LAST,
        customer."id" ${direction}
      OFFSET ${skip}
      LIMIT ${limit}
    `;
    const customerIds = pageRows.map((row) => row.id);
    const customers = customerIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: customerIds } },
          include: getAdminCustomerInclude(),
        })
      : [];
    const customerById = new Map(
      customers.map((customer) => [customer.id, customer]),
    );

    const items = customerIds.map((customerId) => {
      const customer = customerById.get(customerId);
      const customerLocations = [...(customer?.customer_locations ?? [])].sort(
        (a, b) => a.location_id - b.location_id,
      );
      const hasRunchiseDate = Boolean(customer?.runchise_created_at);

      return {
        ...customer,
        location_ids: customerLocations.map((row) => row.location_id),
        customer_locations: customerLocations,
        customer_point: customer?.customer_point ?? {
          total_point: 0,
          available_point: 0,
          next_reward_threshold: DEFAULT_REWARD_THRESHOLD,
        },
        created_at:
          customer?.runchise_created_at ?? customer?.created_at ?? null,
        updated_at:
          customer?.runchise_updated_at ?? customer?.updated_at ?? null,
        date_source: hasRunchiseDate ? 'runchise_sync' : 'local',
      };
    });

    res.json({
      items,
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
      registration_range: {
        earliest: countRow?.earliest ?? null,
        latest: countRow?.latest ?? null,
        source: 'canonical_customer',
      },
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminCustomer(req, res) {
  try {
    if (
      ['balance', 'total_point', 'available_point'].some(
        (field) => req.body[field] !== undefined,
      )
    ) {
      return badRequest(
        res,
        'Saldo dan poin dikelola otomatis dan tidak dapat diubah admin',
      );
    }
    const name = parseRequiredString(req.body.name, 'name', 120);
    const phone_number = normalizePhone(req.body.phone_number);
    const email = parseOptionalEmail(req.body.email);
    const brand_id = parsePositiveInt(req.body.brand_id ?? 1, 'brand_id');
    const owner_location_id = parsePositiveInt(
      req.body.owner_location_id,
      'owner_location_id',
    );
    // H-1: Saldo poin tidak dapat diubah melalui endpoint ini dan hanya dikelola melalui mekanisme khusus yang tervalidasi serta tercatat untuk menjaga integritas data.
    const locationIds = parseLocationIds(
      req.body.location_ids,
      owner_location_id,
    );

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
          activation_status: 'pending_activation',
          activated_at: null,
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
          country: parseOptionalString(
            req.body.country ?? 'Indonesia',
            'country',
            120,
          ),
          postal_code: parseOptionalString(
            req.body.postal_code,
            'postal_code',
            20,
          ),
          dob: parseOptionalDate(req.body.dob, 'dob'),
          gender: parseCustomerGender(req.body.gender),
          status: parseCustomerStatus(req.body.status),
          balance: 0,
          brand_id,
          owner_location_id,
          created_by_id: req.user.id,
          last_updated_by_id: req.user.id,
          customer_point: {
            create: {
              total_point: 0,
              available_point: 0,
              next_reward_threshold: getDefaultRewardThreshold(),
            },
          },
          customer_locations:
            locationIds.length > 0
              ? {
                  create: locationIds.map((location_id) => ({ location_id })),
                }
              : undefined,
        },
        include: getAdminCustomerInclude(),
      });
    });

    const runchiseSync = await syncCustomerToRunchise(customer.id);

    let activationEmail = null;
    if (runchiseSync.status === 'synced') {
      try {
        activationEmail = await sendCustomerActivationLink(customer);
      } catch (emailError) {
        activationEmail = {
          sent: false,
          skipped: false,
          error: emailError.message,
        };
      }
    } else {
      activationEmail = {
        sent: false,
        skipped: true,
        reason: 'runchise_sync_not_synced',
        error:
          runchiseSync.error ||
          runchiseSync.reason ||
          'Customer belum tersinkron ke Runchise',
      };
    }

    const syncedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: getAdminCustomerInclude(),
    });

    await recordAdminActivity({
      req,
      action: 'create_customer',
      entityType: 'customer',
      entityId: syncedCustomer.id,
      after: syncedCustomer,
      metadata: {
        runchise_sync: runchiseSync,
        activation_email: activationEmail,
      },
    });

    res.status(201).json({
      ...syncedCustomer,
      runchise_sync: runchiseSync,
      activation_email: activationEmail,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminCustomer(req, res) {
  try {
    if (
      ['balance', 'total_point', 'available_point'].some(
        (field) => req.body[field] !== undefined,
      )
    ) {
      return badRequest(
        res,
        'Saldo dan poin dikelola otomatis dan tidak dapat diubah admin',
      );
    }
    const id = parsePositiveInt(req.params.id, 'id');
    const beforeCustomer = await getCustomerAuditSnapshot(id);
    const data = {};
    const userData = {};

    if (req.body.name !== undefined)
      data.name = parseRequiredString(req.body.name, 'name', 120);
    if (req.body.phone_number !== undefined) {
      data.phone_number = normalizePhone(req.body.phone_number);
      userData.phone_number = data.phone_number;
    }
    if (req.body.email !== undefined)
      userData.email = parseOptionalEmail(req.body.email);
    if (req.body.phone_number_country_code !== undefined) {
      data.phone_number_country_code = parsePositiveInt(
        req.body.phone_number_country_code,
        'phone_number_country_code',
      );
    }
    if (req.body.address !== undefined)
      data.address = parseOptionalString(req.body.address, 'address', 1000);
    if (req.body.province !== undefined)
      data.province = parseOptionalString(req.body.province, 'province', 120);
    if (req.body.city !== undefined)
      data.city = parseOptionalString(req.body.city, 'city', 120);
    if (req.body.country !== undefined)
      data.country = parseOptionalString(req.body.country, 'country', 120);
    if (req.body.postal_code !== undefined)
      data.postal_code = parseOptionalString(
        req.body.postal_code,
        'postal_code',
        20,
      );
    if (req.body.dob !== undefined)
      data.dob = parseOptionalDate(req.body.dob, 'dob');
    if (req.body.gender !== undefined)
      data.gender = parseCustomerGender(req.body.gender);
    if (req.body.status !== undefined)
      data.status = parseCustomerStatus(req.body.status);
    if (req.body.brand_id !== undefined)
      data.brand_id = parsePositiveInt(req.body.brand_id, 'brand_id');
    if (req.body.owner_location_id !== undefined) {
      data.owner_location_id = parsePositiveInt(
        req.body.owner_location_id,
        'owner_location_id',
      );
    }
    data.last_updated_by_id = req.user.id;

    let shouldSendActivationEmail = false;

    const customer = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({
        where: { id },
        select: {
          user_id: true,
          owner_location_id: true,
          user: {
            select: {
              email: true,
              activation_status: true,
            },
          },
        },
      });

      if (!existing) {
        throw Object.assign(new Error('Customer tidak ditemukan'), {
          code: 'P2025',
        });
      }

      const effectiveOwnerLocationId =
        data.owner_location_id !== undefined
          ? data.owner_location_id
          : existing.owner_location_id;

      if (!effectiveOwnerLocationId) {
      throw new ValidationError('owner_location_id wajib diisi');
      }

      if (Object.keys(userData).length > 0) {
        await tx.user.update({
          where: { id: existing.user_id },
          data: userData,
        });

        if (
          Object.prototype.hasOwnProperty.call(userData, 'email') &&
          userData.email &&
          userData.email !== existing.user?.email &&
          existing.user?.activation_status === 'pending_activation'
        ) {
          shouldSendActivationEmail = true;
        }
      }

      if (
        req.body.location_ids !== undefined ||
        data.owner_location_id !== undefined
      ) {
        const ownerLocationId =
          data.owner_location_id !== undefined
            ? data.owner_location_id
            : existing.owner_location_id;
        const locationIds = parseLocationIds(
          req.body.location_ids,
          ownerLocationId,
        );

        await tx.customerLocation.deleteMany({ where: { customer_id: id } });

        if (locationIds.length > 0) {
          await tx.customerLocation.createMany({
            data: locationIds.map((location_id) => ({
              customer_id: id,
              location_id,
            })),
            skipDuplicates: true,
          });
        }
      }

      return tx.customer.update({
        where: { id },
        data,
        include: getAdminCustomerInclude(),
      });
    });

    const changedFields = getActualCustomerChangedFields({
      before: beforeCustomer,
      after: customer,
      customerFields: Object.keys(data),
      userFields: Object.keys(userData),
      locationIdsTouched: req.body.location_ids !== undefined,
    });

    const runchiseSync = await syncCustomerToRunchise(customer.id);
    const syncedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: getAdminCustomerInclude(),
    });

    let activationEmail = null;
    if (shouldSendActivationEmail) {
      try {
        activationEmail = await sendCustomerActivationLink(syncedCustomer);
      } catch (emailError) {
        activationEmail = {
          sent: false,
          skipped: false,
          error: emailError.message,
        };
      }
    }

    await recordAdminActivity({
      req,
      action: 'update_customer',
      entityType: 'customer',
      entityId: syncedCustomer.id,
      before: beforeCustomer,
      after: syncedCustomer,
      metadata: {
        changed_fields: changedFields,
        runchise_sync: runchiseSync,
        activation_email: activationEmail,
      },
    });

    res.json({
      ...syncedCustomer,
      runchise_sync: runchiseSync,
      activation_email: activationEmail,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function resendCustomerActivation(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone_number: true,
            role: true,
            activation_status: true,
            activated_at: true,
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    if (customer.user.activation_status !== 'pending_activation') {
      return res.status(400).json({
        message: 'Akun customer sudah aktif atau tidak membutuhkan aktivasi',
      });
    }

    const activationEmail = await sendCustomerActivationLink(customer);

    await recordAdminActivity({
      req,
      action: 'resend_customer_activation',
      entityType: 'customer',
      entityId: customer.id,
      after: customer,
      metadata: { activation_email: activationEmail },
    });

    res.json({
      message: activationEmail.sent
        ? 'Email aktivasi berhasil dikirim'
        : 'Email aktivasi belum terkirim',
      activation_email: activationEmail,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function retryCustomerRunchiseSync(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const runchiseSync = await syncCustomerToRunchise(id, {
      allowCreate: false,
    });
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: getAdminCustomerInclude(),
    });

    await recordAdminActivity({
      req,
      action: 'retry_customer_runchise_sync',
      entityType: 'customer',
      entityId: id,
      after: customer,
      metadata: { runchise_sync: runchiseSync },
    });

    res.json({
      ...customer,
      runchise_sync: runchiseSync,
    });
  } catch (error) {
    handleError(res, error);
  }
}

// M-7: Memastikan seluruh relasi foreign key ditangani sesuai aturan database agar penghapusan customer tidak gagal akibat constraint yang belum dibersihkan.
async function deleteAdminCustomer(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { user_id: true, runchise_id: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    await prisma.$transaction([
      // Kebijakan retensi: data transaksi non-PII dipertahankan untuk audit,
      // tetapi seluruh snapshot identitas customer dan payload mentah dibuang
      // atomik sebelum baris Customer/User dihapus.
      prisma.customerSalesTransactionReport.updateMany({
        where: {
          OR: [
            { customer_id: id },
            ...(customer.runchise_id
              ? [{ runchise_customer_id: customer.runchise_id }]
              : []),
          ],
        },
        data: {
          nama_pelanggan: null,
          no_telepon: null,
          raw: Prisma.DbNull,
        },
      }),
      prisma.runchisePosRewardRedemption.updateMany({
        where: {
          OR: [
            { customer_id: id },
            ...(customer.runchise_id
              ? [{ runchise_customer_id: customer.runchise_id }]
              : []),
          ],
        },
        data: {
          customer_name: null,
          customer_phone_number: null,
          raw: Prisma.DbNull,
        },
      }),
      prisma.pointHistory.deleteMany({ where: { customer_id: id } }),
      prisma.rewardRedemption.deleteMany({ where: { customer_id: id } }),
      prisma.customerPoint.deleteMany({ where: { customer_id: id } }),
      prisma.customerLocation.deleteMany({ where: { customer_id: id } }),
      prisma.customer.delete({ where: { id } }),
      prisma.session.deleteMany({ where: { user_id: customer.user_id } }),
      prisma.accountActivationToken.deleteMany({
        where: { user_id: customer.user_id },
      }),
      prisma.user.delete({ where: { id: customer.user_id } }),
    ]);

    await recordAdminActivity({
      req,
      action: 'delete_customer',
      entityType: 'customer',
      entityId: id,
      // Jangan menyalin snapshot customer ke audit log setelah data tersebut
      // dihapus. Keberadaan aksi, actor, waktu, IP, dan entityId sudah cukup
      // untuk audit tanpa mempertahankan PII.
      before: { id },
    });

    res.json({ message: 'Customer berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminBrands(req, res) {
  try {
    const brands = await prisma.brand.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 1000,
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
      orderBy: [{ city: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 1000,
    });

    res.json(locations);
  } catch (error) {
    handleError(res, error);
  }
}

module.exports = {
  listAdminCustomers,
  createAdminCustomer,
  updateAdminCustomer,
  resendCustomerActivation,
  retryCustomerRunchiseSync,
  deleteAdminCustomer,
  listAdminBrands,
  listAdminLocations,
};
