const crypto = require("crypto");

const successRequest = ({
  res,
  code = 200,
  data,
  message = "Successfully",
}) => {
  return res.status(code).json({
    success: true,
    data: data ?? null,
    message,
  });
};

const badRequest = ({ res, code, error }) => {
  const errorId = crypto.randomBytes(4).toString("hex");

  if (!error) error = `Error Bad Request with status code ${code}`;

  return res.status(code).json({
    message: error,
    error_id: errorId,
  });
};

function respondWithServerError(res, error, context = "Unhandled error") {
  const errorId = crypto.randomBytes(4).toString("hex");

  console.error(`[error:${errorId}] ${context}:`, error);

  return res.status(500).json({
    message: error.toString(),
    error_id: errorId,
  });
}

module.exports = { successRequest, badRequest, respondWithServerError };
