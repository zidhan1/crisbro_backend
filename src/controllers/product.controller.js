const {
  syncLoyaltyProducts,
  deleteLoyaltyProduct,
  listLoyaltyProducts,
} = require("../services/product.service");
const { successRequest, badRequest } = require("../utils/responseReuest");

async function listLoyaltyProductsController(req, res) {
  try {
    const { query = "", take = 10, skip = 0 } = req.query;

    const parsedTake = Math.min(Number.parseInt(take, 10) || 10, 100);
    const parsedSkip = Math.max(Number.parseInt(skip, 10) || 0, 0);

    const result = await listLoyaltyProducts({
      query,
      take: parsedTake,
      skip: parsedSkip,
    });

    return successRequest({
      res,
      code: 200,
      message: "Loyalty products retrieved successfully",
      data: result,
    });
  } catch (error) {
    return badRequest({
      res,
      code: 500,
      error: error.message,
    });
  }
}

async function syncLoyaltyProductsController(req, res) {
  try {
    const loyaltyProducts = await syncLoyaltyProducts();

    return successRequest({
      res,
      code: 200,
      message: "Loyalty products synced successfully",
      data: loyaltyProducts,
    });
  } catch (error) {
    return badRequest({
      res,
      code: 500,
      error: error.message,
    });
  }
}

async function deleteLoyaltyProductController(req, res) {
  try {
    const { loyalty_product_id } = req.params;

    if (!loyalty_product_id) {
      return badRequest({
        res,
        code: 400,
        error: "Loyalty product ID is required",
      });
    }

    const deletedProduct = await deleteLoyaltyProduct(loyalty_product_id);

    return successRequest({
      res,
      code: 200,
      message: "Loyalty product deleted successfully",
      data: deletedProduct,
    });
  } catch (error) {
    return badRequest({
      res,
      code: 500,
      error: error.message,
    });
  }
}

module.exports = {
  listLoyaltyProductsController,
  syncLoyaltyProductsController,
  deleteLoyaltyProductController,
};
