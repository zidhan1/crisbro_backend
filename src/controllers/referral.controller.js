const { successRequest, badRequest } = require("../utils/responseReuest");
const {
  CreateReferralProgramSchema,
} = require("../validation/referral/referral-validation");
const {
  generateReferralCodeService,
  renewReferralCodeService,
  validateReferralCodeService,
  listReferralCodeUsagesService,
} = require("../services/referral.service");
const { z } = require("zod");
const {
  DEFAULT_POINT_REWARD,
  DEFAULT_POINT_GIVEN,
  DEFAULT_EXPIRES_TIME,
} = require("../constants/referralCodeValue");

const userIdSchema = z.string().uuid("User ID must be a valid UUID");
const referralStatusSchema = z.enum(["pending", "completed"]).optional();

async function generateReferralCodeController(req, res) {
  const { user_id } = req.user ?? {};
  const body = req.body ?? undefined;
  let payload;

  if (!body || Object.keys(body).length === 0) {
    payload = {
      owner_referral: user_id,
      point_reward: DEFAULT_POINT_REWARD,
      point_given: DEFAULT_POINT_GIVEN,
      expires_at: DEFAULT_EXPIRES_TIME,
    };
  } else {
    payload = {
      ...body,
      owner_referral: user_id,
      expires_at: new Date(body.expires_at),
    };
  }

  const validate = await CreateReferralProgramSchema.safeParse(payload);

  if (!validate.success) {
    return badRequest({
      code: 422,
      res,
      error: validate.error.flatten().fieldErrors,
    });
  }

  const data = validate.data;

  const response = await generateReferralCodeService({
    user_id,
    payload: data,
  });

  if (response.code !== 200) {
    return badRequest({
      res,
      code: response.code,
      error: response.message,
    });
  }

  return successRequest({ res, code: response.code, data: response.data });
}

async function renewReferralCodeController(req, res) {
  const { user_id } = req.user ?? {};
  const body = req.body ?? {};
  const payload = {
    ...body,
    owner_referral: user_id,
    expires_at: body.expires_at
      ? new Date(body.expires_at)
      : DEFAULT_EXPIRES_TIME,
    point_reward: body.point_reward ?? DEFAULT_POINT_REWARD,
    point_given: body.point_given ?? DEFAULT_POINT_GIVEN,
  };

  const validation = CreateReferralProgramSchema.safeParse(payload);

  if (!validation.success) {
    return badRequest({
      res,
      code: 422,
      error: validation.error.flatten().fieldErrors,
    });
  }

  const response = await renewReferralCodeService({
    user_id,
    payload: validation.data,
  });

  if (response.code !== 200) {
    return badRequest({
      res,
      code: response.code,
      error: response.message,
    });
  }

  return successRequest({ res, code: response.code, data: response.data });
}

async function validateReferralCodeController(req, res) {
  const validation = userIdSchema.safeParse(req.params.user_id);

  if (!validation.success) {
    return badRequest({
      res,
      code: 422,
      error: validation.error.flatten().formErrors,
    });
  }

  const response = await validateReferralCodeService({
    user_id: validation.data,
  });

  if (response.code !== 200) {
    return badRequest({
      res,
      code: response.code,
      error: response.message,
    });
  }

  return successRequest({
    res,
    code: response.code,
    data: response.data,
    message: "Referral validated successfully",
  });
}

async function listReferralCodeUsagesController(req, res) {
  const validation = referralStatusSchema.safeParse(req.query.status);

  if (!validation.success) {
    return badRequest({
      res,
      code: 422,
      error: "Status must be pending or completed",
    });
  }

  const response = await listReferralCodeUsagesService({
    status: validation.data,
  });

  return successRequest({
    res,
    code: response.code,
    data: {
      items: response.data,
      meta: response.meta,
    },
    message: "Referral usages retrieved successfully",
  });
}

module.exports = {
  generateReferralCodeController,
  renewReferralCodeController,
  validateReferralCodeController,
  listReferralCodeUsagesController,
};
