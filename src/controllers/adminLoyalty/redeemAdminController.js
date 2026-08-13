function createRedeemAdminControllers({
  prisma,
  Prisma,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
  getRedeemCatalogConfig,
  normalizeReportName,
  parseOptionalString,
  parseRequiredString,
  parsePositiveInt,
  parseBoolean,
  parseNonNegativeInt,
  parseScheduleBoundary,
  buildRedeemItemOrderBy,
  addRedeemPriceBreakdown,
  getDefaultRedeemCategoryId,
  recordAdminActivity,
  handleError,
  badRequest,
  getDefaultRewardThreshold,
  REDEEM_ITEM_SELECT,
  REDEEM_ITEM_AUDIT_INCLUDE,
}) {
  async function listCatalogMenuItems(req, res) {
    try {
      const search = parseOptionalString(req.query.search, 'search', 100);
      const limit = Math.min(
        parsePositiveInt(req.query.limit ?? 50, 'limit'),
        1000,
      );
      const { parentBrandRunchiseId, redeemSubBrandRunchiseId } =
        getRedeemCatalogConfig();
      const redeemSubBrand = await prisma.subBrand.findFirst({
        where: {
          runchise_id: redeemSubBrandRunchiseId,
          brand: { runchise_id: parentBrandRunchiseId },
        },
        select: { id: true },
      });

      if (!redeemSubBrand) {
        return res.json({ categories: [], items: [] });
      }

      const categoryWhere = {
        name: { notIn: Array.from(EXCLUDED_CRISBAR_CATEGORY_NAMES) },
        sub_brand_links: {
          some: {
            sub_brand_id: redeemSubBrand.id,
          },
        },
      };
      const itemWhere = {
        category: categoryWhere,
        is_selectable: true,
        ...(search && {
          name: { contains: search, mode: 'insensitive' },
        }),
      };

      const [categories, items] = await Promise.all([
        prisma.menuCategory.findMany({
          where: {
            ...categoryWhere,
            items: {
              some: search
                ? { name: { contains: search, mode: 'insensitive' } }
                : {},
            },
          },
          select: { id: true, name: true, is_active: true },
          orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
        }),
        prisma.menuItem.findMany({
          where: itemWhere,
          include: {
            category: { select: { id: true, name: true, is_active: true } },
          },
          orderBy: [
            { category: { is_active: 'desc' } },
            { category: { name: 'asc' } },
            { name: 'asc' },
          ],
          take: limit,
        }),
      ]);

      const itemCategoryIds = new Set(
        items.map((item) => item.category?.id).filter(Boolean),
      );
      const visibleCategories = categories.filter((category) =>
        itemCategoryIds.has(category.id),
      );

      res.json({ categories: visibleCategories, items });
    } catch (error) {
      handleError(res, error);
    }
  }

  async function listRedeemCategories(req, res) {
    try {
      const page = parsePositiveInt(req.query.page ?? 1, 'page');
      const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);
      const total = await prisma.redeemMenuCategory.count();
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const clampedPage = Math.min(page, totalPages);
      const categories = await prisma.redeemMenuCategory.findMany({
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        skip: (clampedPage - 1) * limit,
        take: limit,
      });
      res.json({ items: categories, page: clampedPage, limit, total, total_pages: totalPages });
    } catch (error) {
      handleError(res, error);
    }
  }

  async function createRedeemCategory(req, res) {
    try {
      const category = await prisma.redeemMenuCategory.create({
        data: {
          name: parseRequiredString(req.body.name, 'name', 80),
          sort_order: parseNonNegativeInt(
            req.body.sort_order ?? 0,
            'sort_order',
          ),
          is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
        },
      });
      await recordAdminActivity({
        req,
        action: 'create_redeem_category',
        entityType: 'redeem_category',
        entityId: category.id,
        after: category,
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

      if (req.body.name !== undefined)
        data.name = parseRequiredString(req.body.name, 'name', 80);
      if (req.body.sort_order !== undefined)
        data.sort_order = parseNonNegativeInt(
          req.body.sort_order,
          'sort_order',
        );
      if (req.body.is_active !== undefined)
        data.is_active = parseBoolean(req.body.is_active, 'is_active');

      const before = await prisma.redeemMenuCategory.findUnique({
        where: { id },
      });
      const category = await prisma.redeemMenuCategory.update({
        where: { id },
        data,
      });
      await recordAdminActivity({
        req,
        action: 'update_redeem_category',
        entityType: 'redeem_category',
        entityId: category.id,
        before,
        after: category,
        metadata: { changed_fields: Object.keys(data) },
      });
      res.json(category);
    } catch (error) {
      handleError(res, error);
    }
  }

  async function listRedeemItems(req, res) {
    try {
      const sortBy = parseOptionalString(req.query.sort_by, 'sort_by', 50);
      const sortOrder = parseOptionalString(
        req.query.sort_order,
        'sort_order',
        10,
      );
      const page = parsePositiveInt(req.query.page ?? 1, 'page');
      const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);
      const total = await prisma.redeemMenuItem.count();
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const clampedPage = Math.min(page, totalPages);
      const items = await prisma.redeemMenuItem.findMany({
        select: REDEEM_ITEM_SELECT,
        orderBy: buildRedeemItemOrderBy(sortBy, sortOrder),
        skip: (clampedPage - 1) * limit,
        take: limit,
      });

      res.json({
        items: items.map(addRedeemPriceBreakdown),
        page: clampedPage,
        limit,
        total,
        total_pages: totalPages,
      });
    } catch (error) {
      handleError(res, error);
    }
  }

  async function createRedeemItem(req, res) {
    try {
      const categoryId =
        parsePositiveInt(req.body.category_id, 'category_id', {
          required: false,
        }) ?? (await getDefaultRedeemCategoryId());

      const item = await prisma.redeemMenuItem.create({
        data: {
          menu_item_id: parsePositiveInt(req.body.menu_item_id, 'menu_item_id'),
          category_id: categoryId,
          points_required: parsePositiveInt(
            req.body.points_required,
            'points_required',
          ),
          is_active: parseBoolean(req.body.is_active ?? true, 'is_active'),
          badge: parseOptionalString(req.body.badge, 'badge', 40),
          sort_order: parseNonNegativeInt(
            req.body.sort_order ?? 0,
            'sort_order',
          ),
          // M-4 (lanjutan): jendela berlaku dijepit ke hari WIB -- awal hari
          // untuk start_at, akhir hari untuk end_at (jendela inklusif).
          start_at: parseScheduleBoundary(req.body.start_at, 'start_at'),
          end_at: parseScheduleBoundary(req.body.end_at, 'end_at', true),
          stock_limit: parsePositiveInt(req.body.stock_limit, 'stock_limit', {
            required: false,
          }),
          daily_limit: parsePositiveInt(req.body.daily_limit, 'daily_limit', {
            required: false,
          }),
        },
        select: REDEEM_ITEM_SELECT,
      });

      const responseItem = addRedeemPriceBreakdown(item);
      await recordAdminActivity({
        req,
        action: 'create_redeem_item',
        entityType: 'redeem_item',
        entityId: item.id,
        after: responseItem,
      });

      res.status(201).json(responseItem);
    } catch (error) {
      handleError(res, error);
    }
  }

  async function updateRedeemItem(req, res) {
    try {
      const id = parsePositiveInt(req.params.id, 'id');
      const data = {};

      if (req.body.menu_item_id !== undefined)
        data.menu_item_id = parsePositiveInt(
          req.body.menu_item_id,
          'menu_item_id',
        );
      if (req.body.category_id !== undefined)
        data.category_id = parsePositiveInt(
          req.body.category_id,
          'category_id',
        );
      if (req.body.points_required !== undefined)
        data.points_required = parsePositiveInt(
          req.body.points_required,
          'points_required',
        );
      if (req.body.is_active !== undefined)
        data.is_active = parseBoolean(req.body.is_active, 'is_active');
      if (req.body.badge !== undefined)
        data.badge = parseOptionalString(req.body.badge, 'badge', 40);
      if (req.body.sort_order !== undefined)
        data.sort_order = parseNonNegativeInt(
          req.body.sort_order,
          'sort_order',
        );
      if (req.body.start_at !== undefined)
        data.start_at = parseScheduleBoundary(req.body.start_at, 'start_at');
      if (req.body.end_at !== undefined)
        data.end_at = parseScheduleBoundary(req.body.end_at, 'end_at', true);
      if (req.body.stock_limit !== undefined)
        data.stock_limit = parsePositiveInt(
          req.body.stock_limit,
          'stock_limit',
          {
            required: false,
          },
        );
      if (req.body.daily_limit !== undefined)
        data.daily_limit = parsePositiveInt(
          req.body.daily_limit,
          'daily_limit',
          {
            required: false,
          },
        );

      const before = await prisma.redeemMenuItem.findUnique({
        where: { id },
        include: REDEEM_ITEM_AUDIT_INCLUDE,
      });
      const item = await prisma.redeemMenuItem.update({
        where: { id },
        data,
        select: REDEEM_ITEM_SELECT,
      });

      const responseItem = addRedeemPriceBreakdown(item);
      await recordAdminActivity({
        req,
        action: 'update_redeem_item',
        entityType: 'redeem_item',
        entityId: item.id,
        before,
        after: responseItem,
        metadata: { changed_fields: Object.keys(data) },
      });

      res.json(responseItem);
    } catch (error) {
      handleError(res, error);
    }
  }

  async function deleteRedeemItem(req, res) {
    try {
      const id = parsePositiveInt(req.params.id, 'id');
      const before = await prisma.redeemMenuItem.findUnique({
        where: { id },
        include: REDEEM_ITEM_AUDIT_INCLUDE,
      });

      await prisma.redeemMenuItem.delete({ where: { id } });

      await recordAdminActivity({
        req,
        action: 'delete_redeem_item',
        entityType: 'redeem_item',
        entityId: id,
        before,
      });

      res.json({ message: 'Item redeem berhasil dihapus' });
    } catch (error) {
      handleError(res, error);
    }
  }

  // M-8: memperbaiki bug pagination pada redemption list yang sebelumnya hanya mengambil 200 data tanpa skip, sehingga data setelahnya tidak pernah bisa diakses; kini menggunakan pagination lengkap (page/limit/skip + total/total_pages).
  async function listRedemptions(req, res) {
    try {
      const status = parseOptionalString(req.query.status, 'status', 30);
      const allowedStatus = new Set(['pending', 'claimed', 'expired']);

      if (status && !allowedStatus.has(status)) {
        return badRequest(res, 'status tidak valid');
      }

      const page = parsePositiveInt(req.query.page ?? 1, 'page');
      const limit = Math.min(
        parsePositiveInt(req.query.limit ?? 50, 'limit'),
        200,
      );
      const where = status ? { status } : {};

      const total = await prisma.rewardRedemption.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const clampedPage = Math.min(page, totalPages);

      const redemptions = await prisma.rewardRedemption.findMany({
        where,
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
        skip: (clampedPage - 1) * limit,
        take: limit,
      });

      res.json({
        items: redemptions,
        page: clampedPage,
        limit,
        total,
        total_pages: totalPages,
      });
    } catch (error) {
      handleError(res, error);
    }
  }

  // M-5: Perubahan status redemption kini mengikuti state machine tervalidasi dengan penyesuaian poin yang sesuai serta menjaga riwayat klaim untuk menjamin integritas data dan audit.
  const REDEMPTION_STATUS_TRANSITIONS = {
    pending: ['claimed', 'expired'],
    claimed: ['expired'],
    expired: [],
  };

  async function updateRedemptionStatus(req, res) {
    try {
      const id = parsePositiveInt(req.params.id, 'id');
      const nextStatus = parseRequiredString(req.body.status, 'status', 30);
      const allowedStatuses = new Set(['pending', 'claimed', 'expired']);

      if (!allowedStatuses.has(nextStatus)) {
        return badRequest(res, 'status tidak valid');
      }

      const redemption = await prisma.$transaction(async (tx) => {
        // Mengunci data selama transaksi agar permintaan bersamaan tidak memproses redemption yang sama dan menyebabkan poin terpotong dua kali.
        const [current] = await tx.$queryRaw`
        SELECT * FROM "RewardRedemption" WHERE id = ${id} FOR UPDATE
      `;

        if (!current) {
          throw Object.assign(new Error('Redemption tidak ditemukan'), {
            code: 'P2025',
          });
        }

        if (current.status === nextStatus) {
          throw Object.assign(
            new Error(`Redemption sudah berstatus ${nextStatus}`),
            { code: 'INVALID_TRANSITION' },
          );
        }

        const allowedNext = REDEMPTION_STATUS_TRANSITIONS[current.status] ?? [];
        if (!allowedNext.includes(nextStatus)) {
          throw Object.assign(
            new Error(
              `Transisi status ${current.status} -> ${nextStatus} tidak diizinkan`,
            ),
            { code: 'INVALID_TRANSITION' },
          );
        }

        const pointsSpent = Number(current.points_spent) || 0;
        const customerId = Number(current.customer_id);

        if (current.status === 'pending' && nextStatus === 'claimed') {
          // M-5: Mengunci CustomerPoint dengan FOR UPDATE setelah RewardRedemption untuk mencegah race condition dan memastikan saldo poin tetap konsisten saat redemption bersamaan.

          await tx.$executeRaw`
            INSERT INTO "CustomerPoint" (
              "customer_id", "total_point", "available_point",
              "next_reward_threshold", "updated_at"
            ) VALUES (${customerId}, 0, 0, ${getDefaultRewardThreshold()}, CURRENT_TIMESTAMP)
            ON CONFLICT ("customer_id") DO NOTHING
          `;
          const [lockedPoint] = await tx.$queryRaw`
          SELECT available_point FROM "CustomerPoint"
          WHERE customer_id = ${customerId} FOR UPDATE
        `;
          const availablePoint = lockedPoint?.available_point ?? 0;

          if (availablePoint < pointsSpent) {
            throw Object.assign(
              new Error(
                `Poin customer tidak cukup untuk klaim (tersedia ${availablePoint}, dibutuhkan ${pointsSpent})`,
              ),
              { code: 'INSUFFICIENT_POINTS' },
            );
          }

          await tx.customerPoint.update({
            where: { customer_id: customerId },
            data: { available_point: { decrement: pointsSpent } },
          });

          await tx.pointHistory.create({
            data: {
              customer_id: customerId,
              reward_redemption_id: id,
              points_change: -pointsSpent,
              type: 'redeem',
              description: `Klaim reward redemption #${id}`,
            },
          });
        }

        if (current.status === 'claimed' && nextStatus === 'expired') {
          await tx.$executeRaw`
            INSERT INTO "CustomerPoint" (
              "customer_id", "total_point", "available_point",
              "next_reward_threshold", "updated_at"
            ) VALUES (${customerId}, 0, 0, ${getDefaultRewardThreshold()}, CURRENT_TIMESTAMP)
            ON CONFLICT ("customer_id") DO NOTHING
          `;
          await tx.$queryRaw`
            SELECT available_point FROM "CustomerPoint"
            WHERE customer_id = ${customerId} FOR UPDATE
          `;
          await tx.customerPoint.update({
            where: { customer_id: customerId },
            data: { available_point: { increment: pointsSpent } },
          });

          await tx.pointHistory.create({
            data: {
              customer_id: customerId,
              reward_redemption_id: id,
              points_change: pointsSpent,
              type: 'redeem_refund',
              description: `Klaim reward redemption #${id} dibatalkan, poin dikembalikan`,
            },
          });
        }

        return tx.rewardRedemption.update({
          where: { id },
          data: {
            status: nextStatus,
            // redeemed_at hanya diisi saat pertama kali claimed dan dipertahankan pada transisi berikutnya agar riwayat klaim tetap tercatat.
            redeemed_at:
              current.status === 'pending' && nextStatus === 'claimed'
                ? new Date()
                : current.redeemed_at,
          },
          include: {
            reward: { select: { id: true, name: true } },
            customer: { select: { id: true, name: true, phone_number: true } },
          },
        });
      });

      await recordAdminActivity({
        req,
        action: 'update_redemption_status',
        entityType: 'reward_redemption',
        entityId: id,
        after: redemption,
        metadata: { new_status: nextStatus },
      });

      res.json(redemption);
    } catch (error) {
      if (
        error.code === 'INVALID_TRANSITION' ||
        error.code === 'INSUFFICIENT_POINTS'
      ) {
        return badRequest(res, error.message);
      }
      handleError(res, error);
    }
  }

  return {
    listCatalogMenuItems,
    listRedeemCategories,
    createRedeemCategory,
    updateRedeemCategory,
    listRedeemItems,
    createRedeemItem,
    updateRedeemItem,
    deleteRedeemItem,
    listRedemptions,
    updateRedemptionStatus,
  };
}

module.exports = { createRedeemAdminControllers };
