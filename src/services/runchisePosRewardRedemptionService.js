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

// M-9: satu halaman report per iterasi (default 200). Versi lama memuat
// SELURUH CustomerSalesTransactionReport yang cocok filter sekaligus lewat
// satu findMany tanpa batas -- termasuk kolom `raw` (blob JSON penuh sale
// Runchise) per baris, yang memang dibutuhkan fungsi ini (lihat
// extractRewardRedemptions/unwrapSale) sehingga TIDAK bisa disederhanakan
// jadi subset field seperti raw promo. Untuk backfill historis (script CLI
// tanpa filter tanggal) itu berarti ribuan blob JSON penuh menumpuk di
// memori sebelum satu baris pun diproses. Sekarang dipaginasi cursor-based
// (urut oleh id), sehingga jumlah report yang ada di memori pada satu waktu
// selalu terbatas ke satu halaman.
const REPORT_PAGE_SIZE = 200;

function serializeRedemptionRow(row) {
  return {
    ...row,
    redeemed_at:
      row.redeemed_at instanceof Date
        ? row.redeemed_at.toISOString()
        : row.redeemed_at,
    raw: row.raw ?? null,
  };
}

// Satu halaman report ditulis dengan maksimal dua statement SQL. Statement
// pertama menghapus detail lama yang tidak lagi muncul pada snapshot sale;
// statement kedua melakukan INSERT ... ON CONFLICT untuk semua detail baru.
async function bulkWritePosRewardRedemptions(db, reportSnapshots, rows) {
  if (reportSnapshots.length === 0) return;
  const snapshots = reportSnapshots.map((snapshot) => ({
    sale_transaction_id: Number(snapshot.sale_transaction_id),
    detail_ids: snapshot.detail_ids.map(Number),
  }));
  const serializedRows = rows.map(serializeRedemptionRow);

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      DELETE FROM "RunchisePosRewardRedemption" redemption
      USING jsonb_to_recordset(${JSON.stringify(snapshots)}::jsonb) AS snapshot(
        sale_transaction_id integer,
        detail_ids jsonb
      )
      WHERE redemption."sale_transaction_id" = snapshot.sale_transaction_id
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(snapshot.detail_ids) detail_id
          WHERE detail_id::integer = redemption."sale_detail_transaction_id"
        )
    `;

    if (serializedRows.length === 0) return;
    await tx.$executeRaw`
      INSERT INTO "RunchisePosRewardRedemption" (
        "sale_transaction_id", "sale_detail_transaction_id",
        "runchise_product_id", "runchise_customer_id", "customer_id",
        "customer_name", "customer_phone_number", "redeem_menu_item_id",
        "product_name", "location_id", "location_name", "redeemed_at",
        "quantity", "point_per_item", "points_spent", "selling_price",
        "status", "is_managed_reward", "raw", "updated_at"
      )
      SELECT
        incoming.sale_transaction_id, incoming.sale_detail_transaction_id,
        incoming.runchise_product_id, incoming.runchise_customer_id,
        incoming.customer_id, incoming.customer_name,
        incoming.customer_phone_number, incoming.redeem_menu_item_id,
        incoming.product_name, incoming.location_id, incoming.location_name,
        incoming.redeemed_at, incoming.quantity, incoming.point_per_item,
        incoming.points_spent, incoming.selling_price, incoming.status,
        incoming.is_managed_reward, incoming.raw, CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(serializedRows)}::jsonb) AS incoming(
        sale_transaction_id integer,
        sale_detail_transaction_id integer,
        runchise_product_id integer,
        runchise_customer_id integer,
        customer_id integer,
        customer_name text,
        customer_phone_number text,
        redeem_menu_item_id integer,
        product_name text,
        location_id integer,
        location_name text,
        redeemed_at timestamp,
        quantity numeric,
        point_per_item integer,
        points_spent integer,
        selling_price numeric,
        status text,
        is_managed_reward boolean,
        raw jsonb
      )
      ON CONFLICT ("sale_transaction_id", "sale_detail_transaction_id")
      DO UPDATE SET
        "runchise_product_id" = EXCLUDED."runchise_product_id",
        "runchise_customer_id" = EXCLUDED."runchise_customer_id",
        "customer_id" = EXCLUDED."customer_id",
        "customer_name" = EXCLUDED."customer_name",
        "customer_phone_number" = EXCLUDED."customer_phone_number",
        "redeem_menu_item_id" = EXCLUDED."redeem_menu_item_id",
        "product_name" = EXCLUDED."product_name",
        "location_id" = EXCLUDED."location_id",
        "location_name" = EXCLUDED."location_name",
        "redeemed_at" = EXCLUDED."redeemed_at",
        "quantity" = EXCLUDED."quantity",
        "point_per_item" = EXCLUDED."point_per_item",
        "points_spent" = EXCLUDED."points_spent",
        "selling_price" = EXCLUDED."selling_price",
        "status" = EXCLUDED."status",
        "is_managed_reward" = EXCLUDED."is_managed_reward",
        "raw" = EXCLUDED."raw",
        "updated_at" = CURRENT_TIMESTAMP
    `;
  });
}

// M-9: satu halaman report menjadi satu transaksi dengan maksimal dua bulk
// statement, tanpa membuat object Prisma delete/upsert per report/detail.
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

  const managedRewards = await prisma.redeemMenuItem.findMany({
    include: { menu_item: { select: { runchise_id: true, name: true } } },
  });
  const managedByProductId = new Map(
    managedRewards
      .filter((item) => item.menu_item.runchise_id !== null)
      .map((item) => [item.menu_item.runchise_id, item]),
  );

  const summary = {
    transactions_scanned: 0,
    transactions_valid: 0,
    transactions_point_mismatch: 0,
    transactions_no_candidate: 0,
    redemption_rows: 0,
    managed_rows: 0,
  };

  let cursorId = undefined;
  let hasMore = true;

  while (hasMore) {
    const reports = await prisma.customerSalesTransactionReport.findMany({
      where,
      orderBy: { id: 'asc' },
      take: REPORT_PAGE_SIZE,
      ...(cursorId !== undefined
        ? { skip: 1, cursor: { id: cursorId } }
        : {}),
    });

    if (reports.length === 0) break;

    const reportSnapshots = [];
    const redemptionRows = [];

    for (const report of reports) {
      const extracted = extractRewardRedemptions(report, managedByProductId);
      const saleTransactionId = Number(report.runchise_sales_transaction_id);
      const detailIds = extracted.rows.map(
        (item) => item.sale_detail_transaction_id,
      );

      reportSnapshots.push({
        sale_transaction_id: saleTransactionId,
        detail_ids: detailIds,
      });
      redemptionRows.push(...extracted.rows);

      summary.transactions_scanned += 1;
      summary.redemption_rows += extracted.rows.length;
      summary.managed_rows += extracted.rows.filter(
        (item) => item.is_managed_reward,
      ).length;
      if (extracted.valid) summary.transactions_valid += 1;
      else if (extracted.rows.length === 0) summary.transactions_no_candidate += 1;
      else summary.transactions_point_mismatch += 1;
    }

    await bulkWritePosRewardRedemptions(
      prisma,
      reportSnapshots,
      redemptionRows,
    );

    cursorId = reports[reports.length - 1].id;
    hasMore = reports.length === REPORT_PAGE_SIZE;
  }

  return summary;
}

module.exports = {
  extractRewardRedemptions,
  bulkWritePosRewardRedemptions,
  serializeRedemptionRow,
  syncRunchisePosRewardRedemptions,
  unwrapSale,
};
