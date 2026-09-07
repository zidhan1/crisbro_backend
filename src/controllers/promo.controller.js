const { z } = require("zod");
const {
  createPromoService,
  listPromoService,
  showPromoService,
  updatePromoService,
  activatePromoService,
  syncPromoService,
  generatePromoCodeService,
  deactivatePromoService,
} = require("../services/promo.service");
const {
  updatePromoSchema,
} = require("../validation/runchise/runchise-validation");
const { successRequest, badRequest } = require("../utils/responseReuest");

const promoIdSchema = z.string().uuid("ID promo harus berupa UUID yang valid");

function respondPromoError(res, error) {
  if (error instanceof z.ZodError) {
    return badRequest({ res, code: 422, error: error.flatten() });
  }
  return badRequest({
    res,
    code: error.statusCode ?? 500,
    error: error.code === "PROMO_SYNC_FAILED"
      ? { code: error.code, message: error.message, runchise_id: error.runchise_id }
      : error.message,
  });
}

async function syncPromoController(req, res) {
  try {
    const promo = await syncPromoService(req.params.runchise_id);
    return successRequest({ res, data: promo, message: "Promo synchronized successfully" });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

async function generatePromoCodeController(req, res) {
  try {
    const promo = await generatePromoCodeService(req.params.promo_id, req.body);
    return successRequest({
      res,
      code: 201,
      message: "Promo codes generated successfully",
      data: promo,
    });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

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
    return respondPromoError(res, error);
  }
}

async function listPromoController(req, res) {
  try {
    const result = await listPromoService(req.query);

    return successRequest({
      res,
      code: 200,
      message: "Promos retrieved successfully",
      data: result,
    });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

async function showPromoController(req, res) {
  const idValidation = promoIdSchema.safeParse(req.params.promo_id);
  if (!idValidation.success) {
    return badRequest({ res, code: 422, error: idValidation.error.flatten() });
  }

  try {
    const promo = await showPromoService(idValidation.data);

    return successRequest({
      res,
      code: 200,
      message: "Promo retrieved successfully",
      data: promo,
    });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

async function updatePromoController(req, res) {
  const idValidation = promoIdSchema.safeParse(req.params.promo_id);
  const bodyValidation = updatePromoSchema.safeParse(req.body);

  if (!idValidation.success || !bodyValidation.success) {
    const error = !idValidation.success
      ? idValidation.error
      : bodyValidation.error;
    return badRequest({ res, code: 422, error: error.flatten() });
  }

  if (Object.keys(bodyValidation.data).length === 0) {
    return badRequest({
      res,
      code: 422,
      error: "Minimal satu field harus dikirim untuk update promo",
    });
  }

  try {
    const promo = await updatePromoService(
      idValidation.data,
      bodyValidation.data,
    );

    return successRequest({
      res,
      code: 200,
      message: "Promo updated successfully",
      data: promo,
    });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

async function deactivatePromoController(req, res) {
  const idValidation = promoIdSchema.safeParse(req.params.promo_id);

  if (!idValidation.success) {
    const error = idValidation.error;
    return badRequest({ res, code: 422, error: error.flatten() });
  }

  try {
    const promo = await deactivatePromoService(idValidation.data);

    return successRequest({
      res,
      code: 200,
      message: "Promo deactivated successfully",
      data: promo,
    });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

async function activatePromoController(req, res) {
  const idValidation = promoIdSchema.safeParse(req.params.promo_id);

  if (!idValidation.success) {
    const error = idValidation.error;
    return badRequest({ res, code: 422, error: error.flatten() });
  }

  try {
    const promo = await activatePromoService(idValidation.data);

    return successRequest({
      res,
      code: 200,
      message: "Promo activated successfully",
      data: promo,
    });
  } catch (error) {
    return respondPromoError(res, error);
  }
}

module.exports = {
  createPromoController,
  listPromoController,
  showPromoController,
  updatePromoController,
  deactivatePromoController,
  activatePromoController,
  syncPromoController,
  generatePromoCodeController,
};
