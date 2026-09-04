const { createPromoService } = require("../services/promo.service");
const { successRequest, badRequest } = require("../utils/responseReuest");

async function createPromoController(req, res) {
  try {
    const promo = await createPromoService(req.body);

    return successRequest({
      res,
      code: 201,
      message: "Promo created successfully",
      data: promo,
    });
  } catch (error) {
    return badRequest({
      res,
      code: 500,
      error: error.message,
    });
  }
}

module.exports = { createPromoController };
