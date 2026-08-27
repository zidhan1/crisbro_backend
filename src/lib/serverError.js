const crypto = require("crypto");

const GENERIC_MESSAGE =
  "Terjadi kesalahan pada server. Sebutkan kode error berikut bila menghubungi admin.";

function respondWithServerError(res, error, context = "Unhandled error") {
  const errorId = crypto.randomBytes(4).toString("hex");

  console.error(`[error:${errorId}] ${context}:`, error);

  return res.status(500).json({
    message: error.toString(),
    error_id: errorId,
  });
}

module.exports = { respondWithServerError, GENERIC_MESSAGE };
