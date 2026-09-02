const {
  successRequest,
  badRequest,
  respondWithServerError,
} = require("../utils/responseReuest");
const {
  generateSaleTransactionsFromRunchise,
} = require("../services/saleTransaction.service");
const {
  generateSaleTransactionSchema,
} = require("../validation/saleTransaction/saleTransaction-validation");

const CUSTOMER_NOT_FOUND_MESSAGE = "Customer tidak ditemukan";
const CUSTOMER_NOT_SYNCED_MESSAGE =
  "Customer belum tersinkron dengan Runchise (runchise_id kosong)";

function validationError(res, error) {
  return badRequest({
    res,
    code: 422,
    error: error.flatten().fieldErrors,
  });
}

// Menarik sale transaction seorang customer dari Runchise dan menyimpannya
// (upsert) ke tabel SaleTransaction lokal. Idempoten: transaksi yang sama
// tidak diduplikasi karena upsert dilakukan by runchise_id.
async function generateSaleTransactions(req, res) {
  const validation = generateSaleTransactionSchema.safeParse(req.body ?? {});

  if (!validation.success) {
    return validationError(res, validation.error);
  }

  try {
    const summary = await generateSaleTransactionsFromRunchise(
      validation.data.customer_id,
    );

    return successRequest({
      res,
      data: summary,
      message: "Sale transactions berhasil digenerate dari Runchise.",
    });
  } catch (error) {
    if (error.message === CUSTOMER_NOT_FOUND_MESSAGE) {
      return badRequest({ res, code: 404, error: error.message });
    }

    if (error.message === CUSTOMER_NOT_SYNCED_MESSAGE) {
      return badRequest({ res, code: 400, error: error.message });
    }

    // Kegagalan lain umumnya berasal dari API Runchise (timeout/network) atau
    // database; context generate memudahkan pelacakan di log.
    return respondWithServerError(
      res,
      error,
      "Generate sale transactions failed",
    );
  }
}

module.exports = { generateSaleTransactions };
