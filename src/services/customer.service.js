const prisma = require("../lib/prisma");
const { normalizePhone, phoneVariants } = require("../lib/phoneNumber");
const { updateCustomer } = require("./runchise.service");

const ALLOWED_SORT_FIELDS = ["created_at", "name", "phone_number", "status"];
const ALLOWED_UPDATE_FIELDS = [
  "name",
  "phone_number",
  "address",
  "province",
  "city",
  "country",
  "postal_code",
  "gender",
  "status",
  "last_updated_by_id",
  "owner_location_id",
];
const RUNCHISE_UPDATE_FIELDS = [
  "name",
  "phone_number",
  "address",
  "province",
  "city",
  "country",
  "postal_code",
  "gender",
  "status",
  "owner_location_id",
];

function sanitizeOrderBy(sort_by, sort_order) {
  const field = ALLOWED_SORT_FIELDS.includes(sort_by) ? sort_by : "created_at";
  const order = ["asc", "desc"].includes(sort_order) ? sort_order : "desc";
  return { [field]: order };
}

function pickAllowedFields(payload = {}, allowedFields) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => allowedFields.includes(key)),
  );
}

async function listAllCustomers(query = {}) {
  const {
    page = 1,
    limit = 10,
    search = "",
    sort_by = "created_at",
    sort_order = "desc",
  } = query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { phone_number: { contains: search, mode: "insensitive" } },
        ],
      }
    : {};

  try {
    const [customers, total] = await prisma.$transaction([
      prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: sanitizeOrderBy(sort_by, sort_order),
      }),
      prisma.customer.count({ where }),
    ]);

    return {
      data: customers,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total,
        total_pages: Math.ceil(total / Number(limit)),
      },
    };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function getCustomerById(customer_id) {
  if (!customer_id) throw new Error("customer_id is required");

  try {
    const customer = await prisma.customer.findUnique({
      where: { customer_id: customer_id },
    });

    return customer;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function getCustomerByUserId(user_id) {
  if (!user_id) throw new Error("user_id is required");

  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: user_id },
    });

    return customer;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function updateCustomerById(customer_id, payload) {
  const data = pickAllowedFields(payload, ALLOWED_UPDATE_FIELDS);
  const runchiseData = pickAllowedFields(data, RUNCHISE_UPDATE_FIELDS);

  if (Object.keys(data).length === 0) {
    throw new Error("No valid fields to update");
  }

  if (Object.keys(runchiseData).length === 0) {
    throw new Error("No valid Runchise fields to update");
  }

  try {
    // Find customer
    const customer = await prisma.customer.findUnique({
      where: { customer_id: customer_id },
    });

    if (!customer) {
      throw new Error("Customer not found");
    }

    const currentPhone = normalizePhone(customer.phone_number);
    const nextPhone = normalizePhone(data.phone_number);
    const phoneChanged = Boolean(nextPhone && nextPhone !== currentPhone);

    if (phoneChanged) {
      const existingUser = await prisma.user.findFirst({
        where: {
          user_id: { not: customer.user_id },
          phone: { in: phoneVariants(nextPhone) },
        },
        select: { user_id: true },
      });

      if (existingUser) {
        throw new Error("Phone number is already registered");
      }

      data.phone_number = nextPhone;
      runchiseData.phone_number = nextPhone;
    }

    if (!customer.runchise_id || !customer.runchise_location_id) {
      throw new Error(
        "Customer belum terhubung ke Runchise, tidak bisa update",
      );
    }

    // Update on runchise database
    const customerRunchise = await updateCustomer(
      customer.runchise_id,
      customer.runchise_location_id,
      runchiseData,
    );

    let updated;
    try {
      if (phoneChanged) {
        updated = await prisma.$transaction(async (tx) => {
          const updatedCustomer = await tx.customer.update({
            where: { customer_id: customer_id },
            data,
          });

          await tx.user.update({
            where: { user_id: customer.user_id },
            data: {
              phone: nextPhone,
              status: "inactive",
              phone_verified: false,
            },
          });

          return updatedCustomer;
        });
      } else {
        updated = await prisma.customer.update({
          where: { customer_id: customer_id },
          data,
        });
      }
    } catch (localError) {
      console.error(
        `CRITICAL: Runchise updated but local DB failed for customer_id=${customer_id}`,
        localError,
      );
      throw localError;
    }

    return updated;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

module.exports = {
  listAllCustomers,
  getCustomerById,
  getCustomerByUserId,
  updateCustomerById,
};
