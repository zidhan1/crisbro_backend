const prisma = require("../lib/prisma");
const { listSaleTransactionByCustomerId } = require("./runchise.service");

// Runchise API mengirim angka sebagai string (mis. "34400.0") dan
// terkadang mengirim string kosong untuk nilai yang kosong.
function toNullableInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function toNullableFloat(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}

function toNullableString(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

// Satu customer biasanya bertransaksi di sedikit outlet, jadi lookup lokasi
// di-cache per proses generate agar tidak mem-query Location untuk setiap
// transaksi.
function createLocationCache() {
  const cache = new Map();

  return {
    async findByRunchiseId(runchiseLocationId) {
      if (cache.has(runchiseLocationId)) return cache.get(runchiseLocationId);

      const location = await prisma.location.findFirst({
        where: { runchise_id: runchiseLocationId },
      });
      cache.set(runchiseLocationId, location);
      return location;
    },
  };
}

function buildSaleTransactionData(customer, location, transaction) {
  return {
    customer_id: customer.customer_id,
    location_id: location.location_id,
    runchise_id: Number(transaction.id),
    runchise_brand_id: toNullableInt(transaction.brand_id),
    runchise_sales_no: toNullableString(transaction.sales_no),
    runchise_customer_id: toNullableInt(transaction.customer_id),
    runchise_location_id: toNullableInt(transaction.location_id),
    gross_sales: toNullableFloat(transaction.gross_sales),
    net_sales: toNullableFloat(transaction.net_sales),
    location_name: transaction.location_name ?? null,
    order_type_name: transaction.order_type_name ?? null,
    subtotal: toNullableFloat(transaction.subtotal),
    net_sales_after_tax: toNullableFloat(transaction.net_sales_after_tax),
    sales_time: transaction.sales_time ? new Date(transaction.sales_time) : null,
    note: transaction.note ?? null,
    applied_promos_redeemed_point: toNullableInt(
      transaction.applied_promos_redeemed_point,
    ),
    loyalty_discount_fee: toNullableFloat(transaction.loyalty_discount_fee),
  };
}

// Menarik seluruh sale transaction milik seorang customer dari Runchise lalu
// menyimpannya (upsert by runchise_id) ke tabel SaleTransaction lokal.
// Dipakai endpoint admin dan proses aktivasi user lama di auth.service.
async function generateSaleTransactionsFromRunchise(customer_id) {
  if (!customer_id) throw new Error("customer_id is required");

  const customer = await prisma.customer.findUnique({
    where: { customer_id },
    select: { customer_id: true, runchise_id: true, name: true },
  });

  if (!customer) throw new Error("Customer tidak ditemukan");

  if (!customer.runchise_id) {
    throw new Error(
      "Customer belum tersinkron dengan Runchise (runchise_id kosong)",
    );
  }

  const transactions = await listSaleTransactionByCustomerId(
    customer.runchise_id,
  );

  const locationCache = createLocationCache();
  const summary = {
    customer_id: customer.customer_id,
    runchise_customer_id: customer.runchise_id,
    total_fetched: transactions.length,
    upserted: 0,
    skipped_missing_runchise_id: 0,
    skipped_location_not_found: 0,
  };

  for (const transaction of transactions) {
    // id transaksi dipakai sebagai unique key upsert; tanpa itu baris tidak
    // bisa disimpan secara idempoten.
    if (!transaction.id || !Number.isFinite(Number(transaction.id))) {
      summary.skipped_missing_runchise_id += 1;
      console.warn(
        `Transaction without runchise id (sales_no: ${transaction.sales_no}), skip`,
      );
      continue;
    }

    const location = await locationCache.findByRunchiseId(
      transaction.location_id,
    );

    if (!location) {
      summary.skipped_location_not_found += 1;
      console.warn(
        `Location not found for runchise_id: ${transaction.location_id}, skip transaction ${transaction.id}`,
      );
      continue;
    }

    const data = buildSaleTransactionData(customer, location, transaction);

    await prisma.saleTransaction.upsert({
      where: { runchise_id: data.runchise_id },
      create: data,
      update: data,
    });

    summary.upserted += 1;
  }

  return summary;
}

module.exports = { generateSaleTransactionsFromRunchise };
