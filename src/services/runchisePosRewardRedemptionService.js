const prisma = require('../lib/prisma');

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unwrapSale(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.sale_transaction && typeof raw.sale_transaction === 'object'
    ? raw.sale_transaction
    : raw;
}

function extractRewardRedemptions(report, managedByProductId = new Map()) {
  const sale = unwrapSale(report.raw);
  if (!sale) return { rows: [], calculatedPoints: 0, redeemedPoints: 0, valid: false };

  const loyalty = sale.metadata?.loyalty ?? sale.loyalty ?? {};
  const catalog = Array.isArray(loyalty.loyalty_products)
    ? loyalty.loyalty_products
    : [];
  const catalogByProductId = new Map(
    catalog
      .filter((item) => Number.isInteger(Number(item?.product_id)))
      .map((item) => [Number(item.product_id), item]),
  );
  const redeemedPoints = asNumber(
    sale.loyalty?.redeemed_point ??
      sale.metadata?.redeemed_point ??
      sale.metadata?.loyalty?.redeemed_point ??
      report.penggunaan_poin,
  );

  const candidates = (Array.isArray(sale.sale_detail_transactions)
    ? sale.sale_detail_transactions
    : [])
    .filter((detail) => {
      const effectiveQuantity =
        asNumber(detail.quantity) - asNumber(detail.cancelled_quantity);
      return (
        detail.deleted !== true &&
        catalogByProductId.has(Number(detail.product_id)) &&
        asNumber(detail.price) === 0 &&
        effectiveQuantity > 0
      );
    })
    .map((detail) => {
      const productId = Number(detail.product_id);
      const loyaltyProduct = catalogByProductId.get(productId);
      const managed = managedByProductId.get(productId) ?? null;
      const quantity =
        asNumber(detail.quantity) - asNumber(detail.cancelled_quantity);
      const pointPerItem = asNumber(loyaltyProduct.point_needed);

      return {
        sale_transaction_id: Number(sale.id ?? report.runchise_sales_transaction_id),
        sale_detail_transaction_id: Number(detail.id),
        runchise_product_id: productId,
        runchise_customer_id:
          Number(sale.customer_id ?? report.runchise_customer_id) || null,
        customer_id: report.customer_id ?? null,
        customer_name: sale.customer_name || report.nama_pelanggan || null,
        customer_phone_number:
          report.no_telepon ||
          (sale.customer_phone_number
            ? `${sale.customer_phone_number_country_code ?? ''}${sale.customer_phone_number}`
            : null),
        redeem_menu_item_id: managed?.id ?? null,
        product_name: detail.product_name ?? managed?.menu_item?.name ?? `Produk ${productId}`,
        location_id: Number(sale.location_id ?? report.runchise_location_id ?? report.source_location_id),
        location_name: sale.location_name ?? report.nama_outlet ?? null,
        redeemed_at: new Date(
          sale.sales_time ?? sale.local_sales_time ?? report.tanggal_transaksi,
        ),
        quantity,
        point_per_item: pointPerItem,
        points_spent: quantity * pointPerItem,
        selling_price: asNumber(detail.meta?.sell_price ?? detail.price),
        is_managed_reward: Boolean(managed),
        raw: {
          loyalty_product: loyaltyProduct,
          sale_detail_transaction: detail,
          transaction_redeemed_point: redeemedPoints,
        },
      };
    });

  const calculatedPoints = candidates.reduce(
    (total, item) => total + item.points_spent,
    0,
  );
  const valid =
    redeemedPoints > 0 &&
    candidates.length > 0 &&
    Math.abs(calculatedPoints - redeemedPoints) < 0.0001;

  return {
    rows: candidates.map((item) => ({
      ...item,
      points_spent: Math.round(item.points_spent),
      status: valid ? 'valid' : 'point_mismatch',
    })),
    calculatedPoints,
    redeemedPoints,
    valid,
  };
}

async function syncRunchisePosRewardRedemptions({
  locationId,
  startDate,
  endDate,
} = {}) {
  const where = {
    penggunaan_poin: { gt: 0 },
    ...(locationId ? { source_location_id: Number(locationId) } : {}),
    ...(startDate || endDate
      ? {
          tanggal_transaksi: {
            ...(startDate ? { gte: new Date(`${startDate}T00:00:00+07:00`) } : {}),
            ...(endDate ? { lt: new Date(`${endDate}T00:00:00+07:00`) } : {}),
          },
        }
      : {}),
  };
  const [reports, managedRewards] = await Promise.all([
    prisma.customerSalesTransactionReport.findMany({ where }),
    prisma.redeemMenuItem.findMany({
      include: { menu_item: { select: { runchise_id: true, name: true } } },
    }),
  ]);
  const managedByProductId = new Map(
    managedRewards
      .filter((item) => item.menu_item.runchise_id !== null)
      .map((item) => [item.menu_item.runchise_id, item]),
  );
  const summary = {
    transactions_scanned: reports.length,
    transactions_valid: 0,
    transactions_point_mismatch: 0,
    transactions_no_candidate: 0,
    redemption_rows: 0,
    managed_rows: 0,
  };

  for (const report of reports) {
    const extracted = extractRewardRedemptions(report, managedByProductId);
    const saleTransactionId = Number(report.runchise_sales_transaction_id);
    const detailIds = extracted.rows.map((item) => item.sale_detail_transaction_id);
    const writes = [
      prisma.runchisePosRewardRedemption.deleteMany({
        where: {
          sale_transaction_id: saleTransactionId,
          ...(detailIds.length > 0
            ? { sale_detail_transaction_id: { notIn: detailIds } }
            : {}),
        },
      }),
      ...extracted.rows.map((row) =>
        prisma.runchisePosRewardRedemption.upsert({
          where: {
            sale_transaction_id_sale_detail_transaction_id: {
              sale_transaction_id: row.sale_transaction_id,
              sale_detail_transaction_id: row.sale_detail_transaction_id,
            },
          },
          create: row,
          update: row,
        }),
      ),
    ];
    await prisma.$transaction(writes);

    summary.redemption_rows += extracted.rows.length;
    summary.managed_rows += extracted.rows.filter((item) => item.is_managed_reward).length;
    if (extracted.valid) summary.transactions_valid += 1;
    else if (extracted.rows.length === 0) summary.transactions_no_candidate += 1;
    else summary.transactions_point_mismatch += 1;
  }

  return summary;
}

module.exports = {
  extractRewardRedemptions,
  syncRunchisePosRewardRedemptions,
  unwrapSale,
};
