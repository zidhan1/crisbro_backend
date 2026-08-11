const prisma = require('../../lib/prisma');
const bcrypt = require('bcrypt');
const { recordAdminActivity } = require('../../services/adminActivityLogService');
const {
  ADMIN_USER_ROLES,
  ADMIN_USER_UPDATE_FIELDS,
  badRequest,
  buildAdminUserOrderBy,
  handleError,
  normalizePhone,
  parseAdminUserRole,
  parseDateBoundary,
  parseOptionalEmail,
  parseOptionalString,
  parsePositiveInt,
  parseRequiredString,
} = require('./adminLoyaltyShared');

// L-7: domain "user admin & activity log" dipisah dari controller raksasa.
// Isi fungsi dipindahkan apa adanya, termasuk guard M-1 pada updateAdminUser.

async function listAdminUsers(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const sortBy = parseOptionalString(req.query.sort_by, 'sort_by', 50);
    const sortOrder = parseOptionalString(
      req.query.sort_order,
      'sort_order',
      10,
    );
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(parsePositiveInt(req.query.limit ?? 50, 'limit'), 100);
    const where = {
      role: { in: ['admin', 'marketing'] },
      ...(search && {
        OR: [
          { email: { contains: search, mode: 'insensitive' } },
          { phone_number: { contains: search } },
          { role: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
    const total = await prisma.user.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: buildAdminUserOrderBy(sortBy, sortOrder),
      skip: (clampedPage - 1) * limit,
      take: limit,
    });

    res.json({ items: users, page: clampedPage, limit, total, total_pages: totalPages });
  } catch (error) {
    handleError(res, error);
  }
}

async function listAdminActivityLogs(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const action = parseOptionalString(req.query.action, 'action', 80);
    const entityType = parseOptionalString(
      req.query.entity_type,
      'entity_type',
      80,
    );
    const actorId = parsePositiveInt(req.query.actor_user_id, 'actor_user_id', {
      required: false,
    });
    const from = parseDateBoundary(req.query.from, 'from');
    const to = parseDateBoundary(req.query.to, 'to', true);
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 50, 'limit'),
      100,
    );
    const where = {
      ...(action ? { action } : {}),
      ...(entityType ? { entity_type: entityType } : {}),
      ...(actorId ? { actor_user_id: actorId } : {}),
      ...(from || to
        ? {
            created_at: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { action: { contains: search, mode: 'insensitive' } },
              { entity_type: { contains: search, mode: 'insensitive' } },
              { actor_role: { contains: search, mode: 'insensitive' } },
              { actor: { email: { contains: search, mode: 'insensitive' } } },
              { actor: { phone_number: { contains: search } } },
            ],
          }
        : {}),
    };

    const total = await prisma.adminActivityLog.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const logs = await prisma.adminActivityLog.findMany({
      where,
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            phone_number: true,
            role: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      skip: (clampedPage - 1) * limit,
      take: limit,
    });

    res.json({
      items: logs,
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
    });
  } catch (error) {
    handleError(res, error);
  }
}

async function createAdminUser(req, res) {
  try {
    const email = parseOptionalEmail(req.body.email);
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

    await recordAdminActivity({
      req,
      action: 'create_admin_user',
      entityType: 'user',
      entityId: user.id,
      after: user,
      metadata: { role },
    });

    res.status(201).json(user);
  } catch (error) {
    handleError(res, error);
  }
}

async function updateAdminUser(req, res) {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const unexpectedFields = Object.keys(req.body).filter(
      (field) => !ADMIN_USER_UPDATE_FIELDS.has(field),
    );
    if (unexpectedFields.length > 0) {
      return badRequest(
        res,
        `Field tidak diizinkan: ${unexpectedFields.join(', ')}`,
      );
    }

    // Guard target dijalankan sebelum parsing password/bcrypt dan sebelum
    // mutasi apa pun. Endpoint staff tidak boleh menjadi jalur modifikasi atau
    // promosi akun customer walaupun caller mengetahui ID user tersebut.
    const before = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        phone_number: true,
        role: true,
        created_at: true,
        updated_at: true,
        customer: { select: { id: true } },
      },
    });

    if (!before) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    if (!ADMIN_USER_ROLES.has(before.role) || before.customer) {
      return badRequest(
        res,
        'Hanya akun staff admin atau marketing yang dapat diubah dari menu ini',
      );
    }

    const data = {};

    if (req.body.email !== undefined)
      data.email = parseOptionalEmail(req.body.email);
    if (req.body.phone_number !== undefined)
      data.phone_number = normalizePhone(req.body.phone_number);
    if (req.body.role !== undefined)
      data.role = parseAdminUserRole(req.body.role);

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

    const mustRevokeSessions =
      data.password_hash !== undefined ||
      (data.role !== undefined && data.role !== before.role);
    const transactionResult = await prisma.$transaction(async (tx) => {
      // Guard diulang dalam WHERE mutasi untuk mencegah race antara pembacaan
      // `before` dan update. updateMany memberi count tanpa melempar P2025.
      const updateResult = await tx.user.updateMany({
        where: {
          id,
          role: { in: [...ADMIN_USER_ROLES] },
          customer: { is: null },
        },
        data,
      });

      if (updateResult.count !== 1) return { conflict: true, user: null };

      if (mustRevokeSessions) {
        await tx.session.deleteMany({ where: { user_id: id } });
      }

      const user = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          phone_number: true,
          role: true,
          created_at: true,
          updated_at: true,
        },
      });

      return { conflict: false, user };
    });
    const user = transactionResult.user;

    if (transactionResult.conflict || !user) {
      return res.status(409).json({
        message:
          'Target berubah saat diproses; silakan muat ulang dan coba lagi',
      });
    }

    await recordAdminActivity({
      req,
      action: 'update_admin_user',
      entityType: 'user',
      entityId: user.id,
      before: {
        id: before.id,
        email: before.email,
        phone_number: before.phone_number,
        role: before.role,
        created_at: before.created_at,
        updated_at: before.updated_at,
      },
      after: user,
      metadata: {
        changed_fields: Object.keys(data),
        sessions_revoked: mustRevokeSessions,
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
      return badRequest(
        res,
        'User customer tidak dapat dihapus dari menu admin ini',
      );
    }

    await prisma.$transaction([
      prisma.session.deleteMany({ where: { user_id: id } }),
      prisma.user.delete({ where: { id } }),
    ]);

    await recordAdminActivity({
      req,
      action: 'delete_admin_user',
      entityType: 'user',
      entityId: id,
      before: user,
    });

    res.json({ message: 'User berhasil dihapus' });
  } catch (error) {
    handleError(res, error);
  }
}

module.exports = {
  listAdminUsers,
  listAdminActivityLogs,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
};
