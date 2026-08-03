require('dotenv').config();

const prisma = require('../src/lib/prisma');

async function main() {
  const redeemedReports = await prisma.customerSalesTransactionReport.findMany({
    where: {
      source_location_id: 4453,
      tanggal_transaksi: {
        gte: new Date('2026-07-01T00:00:00+07:00'),
        lt: new Date('2026-08-01T00:00:00+07:00'),
      },
      penggunaan_poin: { gt: 0 },
    },
    select: { runchise_sales_transaction_id: true, penggunaan_poin: true, raw: true },
  });
  const rows = await prisma.runchisePosRewardRedemption.findMany({
    where: {
      OR: [{ sale_transaction_id: 162656087 }, { status: 'point_mismatch' }],
    },
    orderBy: [{ sale_transaction_id: 'asc' }, { points_spent: 'desc' }],
  });
  const totals = await prisma.runchisePosRewardRedemption.groupBy({
    by: ['status', 'is_managed_reward'],
    _count: { id: true },
    _sum: { points_spent: true, quantity: true },
  });
  const customerCoverage = await prisma.runchisePosRewardRedemption.aggregate({
    _count: {
      id: true,
      customer_id: true,
      runchise_customer_id: true,
      customer_name: true,
      customer_phone_number: true,
    },
  });
  const storedSaleIds = new Set(
    await prisma.runchisePosRewardRedemption
      .findMany({ select: { sale_transaction_id: true }, distinct: ['sale_transaction_id'] })
      .then((items) => items.map((item) => item.sale_transaction_id)),
  );
  const missingTransactions = redeemedReports
    .filter((report) => !storedSaleIds.has(report.runchise_sales_transaction_id))
    .map((report) => {
      const sale = report.raw?.sale_transaction ?? report.raw ?? {};
      const catalogIds = new Set(
        (sale.metadata?.loyalty?.loyalty_products ?? []).map((item) => Number(item.product_id)),
      );
      return {
        sale_transaction_id: report.runchise_sales_transaction_id,
        redeemed_point: Number(report.penggunaan_poin),
        loyalty_redeemed_point: Number(sale.loyalty?.redeemed_point ?? 0),
        matching_details: (sale.sale_detail_transactions ?? [])
          .filter((detail) => catalogIds.has(Number(detail.product_id)))
          .map((detail) => ({
            id: detail.id,
            product_id: detail.product_id,
            product_name: detail.product_name,
            price: detail.price,
            quantity: detail.quantity,
            cancelled_quantity: detail.cancelled_quantity,
          })),
      };
    });

  console.log(JSON.stringify({
    totals,
    customerCoverage: customerCoverage._count,
    missingTransactions,
    rows: rows.map(({ raw, ...row }) => ({
      ...row,
      id: String(row.id),
      quantity: Number(row.quantity),
      selling_price: Number(row.selling_price),
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
