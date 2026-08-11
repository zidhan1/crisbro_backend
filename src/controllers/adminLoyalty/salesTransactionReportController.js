const prisma = require('../../lib/prisma');
const {
  badRequest,
  handleError,
  parseDateBoundary,
  parseOptionalString,
  parsePositiveInt,
} = require('./adminLoyaltyShared');

// L-7: laporan transaksi customer dipisah dari controller raksasa. Isi fungsi
// dipindahkan apa adanya, termasuk pemisahan endpoint outlet dari M-8.

async function listCustomerSalesTransactionReports(req, res) {
  try {
    const search = parseOptionalString(req.query.search, 'search', 100);
    const outlet = parseOptionalString(req.query.outlet, 'outlet', 120);
    const from = parseDateBoundary(req.query.from, 'from');
    const to = parseDateBoundary(req.query.to, 'to', true);
    if (from && to && from > to) {
      return badRequest(res, 'from tidak boleh melebihi to');
    }
    const page = parsePositiveInt(req.query.page ?? 1, 'page');
    const limit = Math.min(
      parsePositiveInt(req.query.limit ?? 20, 'limit'),
      100,
    );
    const where = {
      AND: [
        {
          OR: [
            { penambahan_poin: { not: 0 } },
            { penggunaan_poin: { not: 0 } },
          ],
        },
        ...(search
          ? [
              {
                OR: [
                  {
                    nama_pelanggan: {
                      contains: search,
                      mode: 'insensitive',
                    },
                  },
                  { no_telepon: { contains: search } },
                  {
                    nama_outlet: { contains: search, mode: 'insensitive' },
                  },
                  {
                    tipe_order: { contains: search, mode: 'insensitive' },
                  },
                ],
              },
            ]
          : []),
      ],
      ...(outlet
        ? { nama_outlet: { equals: outlet, mode: 'insensitive' } }
        : {}),
      ...(from || to
        ? {
            tanggal_transaksi: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const total = await prisma.customerSalesTransactionReport.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, totalPages);
    const reports = await prisma.customerSalesTransactionReport.findMany({
      where,
      orderBy: [{ tanggal_transaksi: 'desc' }, { id: 'desc' }],
      skip: (clampedPage - 1) * limit,
      take: limit,
    });
    const reportTransactionIds = reports.map(
      (report) => report.runchise_sales_transaction_id,
    );
    const rewardRedemptions = reportTransactionIds.length
      ? await prisma.runchisePosRewardRedemption.findMany({
          where: {
            sale_transaction_id: { in: reportTransactionIds },
            status: 'valid',
          },
          select: {
            id: true,
            sale_transaction_id: true,
            runchise_product_id: true,
            redeem_menu_item_id: true,
            product_name: true,
            quantity: true,
            point_per_item: true,
            points_spent: true,
            is_managed_reward: true,
          },
          orderBy: [{ sale_transaction_id: 'asc' }, { id: 'asc' }],
        })
      : [];
    const rewardsByTransactionId = new Map();
    for (const reward of rewardRedemptions) {
      const items =
        rewardsByTransactionId.get(reward.sale_transaction_id) ?? [];
      items.push({
        id: reward.id.toString(),
        runchise_product_id: reward.runchise_product_id,
        redeem_menu_item_id: reward.redeem_menu_item_id,
        product_name: reward.product_name,
        quantity: Number(reward.quantity),
        point_per_item: reward.point_per_item,
        points_spent: reward.points_spent,
        is_managed_reward: reward.is_managed_reward,
      });
      rewardsByTransactionId.set(reward.sale_transaction_id, items);
    }
    res.json({
      items: reports.map((report) => ({
        ...report,
        redeemed_rewards:
          rewardsByTransactionId.get(report.runchise_sales_transaction_id) ??
          [],
        import_run_id:
          report.import_run_id === null || report.import_run_id === undefined
            ? null
            : report.import_run_id.toString(),
      })),
      page: clampedPage,
      limit,
      total,
      total_pages: totalPages,
    });
  } catch (error) {
    handleError(res, error);
  }
}

// M-8: Daftar outlet dipisahkan ke endpoint khusus agar dimuat sekali saja dan tidak menghitung ulang tabel transaksi pada setiap permintaan.
async function listCustomerSalesTransactionReportOutlets(req, res) {
  try {
    const outletRows = await prisma.customerSalesTransactionReport.findMany({
      where: { nama_outlet: { not: null } },
      distinct: ['nama_outlet'],
      select: { nama_outlet: true },
      orderBy: { nama_outlet: 'asc' },
    });

    res.json(outletRows.map((row) => row.nama_outlet).filter(Boolean));
  } catch (error) {
    handleError(res, error);
  }
}

module.exports = {
  listCustomerSalesTransactionReports,
  listCustomerSalesTransactionReportOutlets,
};
