const { z } = require("zod");
const {
  successRequest,
  badRequest,
  respondWithServerError,
} = require("../utils/responseReuest");
const {
  listAllCustomers,
  getCustomerById,
  getCustomerByUserId,
  updateCustomerById,
} = require("../services/customer.service");
const {
  updateCustomerSchema,
} = require("../validation/customer/customer-validation");

const uuidSchema = z.string().uuid("ID must be a valid UUID");
const listCustomersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  search: z.string().default(""),
  sort_by: z
    .enum(["created_at", "name", "phone_number", "status"])
    .default("created_at"),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
});
const updateMyCustomerSchema = updateCustomerSchema.omit({
  status: true,
  last_updated_by_id: true,
  owner_location_id: true,
});

function validationError(res, error) {
  return badRequest({
    res,
    code: 422,
    error: error.flatten().fieldErrors,
  });
}

async function listCustomers(req, res) {
  const validation = listCustomersQuerySchema.safeParse(req.query);

  if (!validation.success) {
    return validationError(res, validation.error);
  }

  try {
    const result = await listAllCustomers(validation.data);

    return successRequest({
      res,
      data: result,
      message: "Customers retrieved successfully.",
    });
  } catch (error) {
    return respondWithServerError(res, error, "List customers failed");
  }
}

async function getCustomer(req, res) {
  const validation = uuidSchema.safeParse(req.params.customer_id);

  if (!validation.success) {
    return validationError(res, validation.error);
  }

  try {
    const customer = await getCustomerById(validation.data);

    if (!customer) {
      return badRequest({ res, code: 404, error: "Customer not found" });
    }

    return successRequest({
      res,
      data: customer,
      message: "Customer retrieved successfully.",
    });
  } catch (error) {
    return respondWithServerError(res, error, "Get customer failed");
  }
}

async function getCustomerByUser(req, res) {
  const validation = uuidSchema.safeParse(req.params.user_id);

  if (!validation.success) {
    return validationError(res, validation.error);
  }

  try {
    const customer = await getCustomerByUserId(validation.data);

    if (!customer) {
      return badRequest({ res, code: 404, error: "Customer not found" });
    }

    return successRequest({
      res,
      data: customer,
      message: "Customer retrieved successfully.",
    });
  } catch (error) {
    return respondWithServerError(res, error, "Get customer by user failed");
  }
}

async function updateCustomer(req, res) {
  const idValidation = uuidSchema.safeParse(req.params.customer_id);

  if (!idValidation.success) {
    return validationError(res, idValidation.error);
  }

  const payload = {
    ...(req.body ?? {}),
    ...(req.user?.user_id
      ? { last_updated_by_id: req.user.user_id }
      : {}),
  };
  const bodyValidation = updateCustomerSchema.safeParse(payload);

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
    const customer = await updateCustomerById(
      idValidation.data,
      bodyValidation.data,
    );

    return successRequest({
      res,
      data: customer,
      message: "Customer updated successfully.",
    });
  } catch (error) {
    if (error.message === "Customer not found") {
      return badRequest({ res, code: 404, error: error.message });
    }

    if (error.message === "Phone number is already registered") {
      return badRequest({ res, code: 409, error: error.message });
    }

    if (
      error.message === "No valid fields to update" ||
      error.message === "No valid Runchise fields to update" ||
      error.message === "Customer belum terhubung ke Runchise, tidak bisa update"
    ) {
      return badRequest({ res, code: 422, error: error.message });
    }

    return respondWithServerError(res, error, "Update customer failed");
  }
}

async function getMyCustomer(req, res) {
  try {
    const customer = await getCustomerByUserId(req.user.user_id);

    if (!customer) {
      return badRequest({ res, code: 404, error: "Customer not found" });
    }

    return successRequest({
      res,
      data: customer,
      message: "Customer profile retrieved successfully.",
    });
  } catch (error) {
    return respondWithServerError(res, error, "Get own customer profile failed");
  }
}

async function updateMyCustomer(req, res) {
  const validation = updateMyCustomerSchema.safeParse(req.body ?? {});

  if (!validation.success) {
    return validationError(res, validation.error);
  }

  if (Object.keys(validation.data).length === 0) {
    return badRequest({
      res,
      code: 422,
      error: "At least one field must be provided",
    });
  }

  try {
    const customer = await getCustomerByUserId(req.user.user_id);

    if (!customer) {
      return badRequest({ res, code: 404, error: "Customer not found" });
    }

    const updatedCustomer = await updateCustomerById(customer.customer_id, {
      ...validation.data,
      last_updated_by_id: req.user.user_id,
    });

    return successRequest({
      res,
      data: updatedCustomer,
      message: "Customer profile updated successfully.",
    });
  } catch (error) {
    if (error.message === "Customer not found") {
      return badRequest({ res, code: 404, error: error.message });
    }

    if (error.message === "Phone number is already registered") {
      return badRequest({ res, code: 409, error: error.message });
    }

    if (
      error.message === "No valid fields to update" ||
      error.message === "No valid Runchise fields to update" ||
      error.message === "Customer belum terhubung ke Runchise, tidak bisa update"
    ) {
      return badRequest({ res, code: 422, error: error.message });
    }

    return respondWithServerError(res, error, "Update own customer profile failed");
  }
}

module.exports = {
  listCustomers,
  getCustomer,
  getCustomerByUser,
  updateCustomer,
  getMyCustomer,
  updateMyCustomer,
};
