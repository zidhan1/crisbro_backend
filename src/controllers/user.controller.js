const { z } = require("zod");
const {
  successRequest,
  badRequest,
  respondWithServerError,
} = require("../utils/responseReuest");
const {
  createUserService,
  updateUserService,
} = require("../services/user.service");
const {
  createUserSchema,
  updateUserSchema,
} = require("../validation/user/user-validation");

const uuidSchema = z.string().uuid("ID must be a valid UUID");

const DUPLICATE_CREATE_MESSAGE = "User with username/email/phone has been created.";
const DUPLICATE_UPDATE_MESSAGE =
  "Email/username/phone/referral code/no referensi sudah dipakai user lain";

function validationError(res, error) {
  return badRequest({
    res,
    code: 422,
    error: error.flatten().fieldErrors,
  });
}

// Jangan pernah mengembalikan hash password atau token verifikasi ke klien.
function toPublicUser(user) {
  if (!user) return user;

  const {
    password_hash,
    email_verification_token,
    email_verification_expires,
    ...publicUser
  } = user;

  return publicUser;
}

async function createUser(req, res) {
  const validation = createUserSchema.safeParse(req.body ?? {});

  if (!validation.success) {
    return validationError(res, validation.error);
  }

  try {
    const user = await createUserService(validation.data);

    return successRequest({
      res,
      code: 201,
      data: toPublicUser(user),
      message: "User created successfully.",
    });
  } catch (error) {
    if (error.message === DUPLICATE_CREATE_MESSAGE) {
      return badRequest({ res, code: 409, error: error.message });
    }

    if (error.message === "No valid fields to create") {
      return badRequest({ res, code: 422, error: error.message });
    }

    return respondWithServerError(res, error, "Create user failed");
  }
}

async function updateUser(req, res) {
  const idValidation = uuidSchema.safeParse(req.params.user_id);

  if (!idValidation.success) {
    return validationError(res, idValidation.error);
  }

  const bodyValidation = updateUserSchema.safeParse(req.body ?? {});

  if (!bodyValidation.success) {
    return validationError(res, bodyValidation.error);
  }

  if (Object.keys(bodyValidation.data).length === 0) {
    return badRequest({
      res,
      code: 422,
      error: "At least one field must be provided",
    });
  }

  try {
    const user = await updateUserService(
      idValidation.data,
      bodyValidation.data,
    );

    return successRequest({
      res,
      data: toPublicUser(user),
      message: "User updated successfully.",
    });
  } catch (error) {
    if (error.message === "User not found") {
      return badRequest({ res, code: 404, error: error.message });
    }

    if (error.message === DUPLICATE_UPDATE_MESSAGE) {
      return badRequest({ res, code: 409, error: error.message });
    }

    if (error.message === "No valid fields to update") {
      return badRequest({ res, code: 422, error: error.message });
    }

    return respondWithServerError(res, error, "Update user failed");
  }
}

module.exports = { createUser, updateUser };
