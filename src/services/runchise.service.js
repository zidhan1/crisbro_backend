const prisma = require("../lib/prisma");
const dotenv = require("dotenv");
const axios = require("axios");
const {
  createCustomerSchema,
  createPromoSchema,
  updatePromoSchema,
} = require("../validation/runchise/runchise-validation");
const {
  updateCustomerSchema,
} = require("../validation/customer/customer-validation");
const { generateRandomUniqueCode } = require("../utils/generateReferralCode");

dotenv.config();

const runchiseClient = axios.create({
  baseURL: "https://runchise-api.crispybakar.biz/api/public",
  timeout: 15000, // 15 detik
  headers: {
    Accept: "application/json",
    Authorization: process.env.RUNCHISE_API_KEY,
    "Content-Type": "application/json",
  },
});

function normalizeIndonesianPhone(raw) {
  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("62")) return digits.slice(2);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits;
}

async function findCustomerByPhone({ phone }) {
  const phone_number = normalizeIndonesianPhone(phone);
  const locationIds = await findAllLocationIds();

  for (const locationId of locationIds) {
    try {
      const result = await runchiseClient.get(
        `/locations/${locationId}/customers?phone_number=${phone_number}`,
      );
      const customer = result.data?.customers?.[0];
      if (customer) return customer;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  return null;
}

async function createCustomer(payload) {
  try {
    const validate = createCustomerSchema.safeParse(payload);

    if (!validate.success) {
      throw new Error(JSON.stringify(validate.error.flatten().fieldErrors));
    }

    const data = validate.data;
    const result = await runchiseClient.post(
      `/locations/${data.owner_location_id}/customers`,
      data,
    );

    return result.data?.customer ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = JSON.stringify(error.response.data.errors);
      throw new Error(message);
    }
    throw error;
  }
}

async function updateCustomer(
  runchise_customer_id,
  runchise_location_id,
  payload,
) {
  try {
    const validate = updateCustomerSchema.safeParse(payload);

    if (!validate.success) {
      throw new Error(JSON.stringify(validate.error.flatten().fieldErrors));
    }

    const data = validate.data;
    const result = await runchiseClient.patch(
      `/locations/${runchise_location_id}/customers/${runchise_customer_id}`,
      data,
    );

    return result.data?.customer ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw new Error(message);
    }
    throw error;
  }
}

async function findAllLocationIds() {
  try {
    const result = await runchiseClient.get(`/locations`);
    const locations = result.data?.locations;

    if (!Array.isArray(locations)) {
      throw new Error("Tidak dapat menemukan location id");
    }

    return locations
      .map((location) => Number(location.id))
      .filter((id) => Number.isInteger(id) && id > 0);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function listAllLocations() {
  try {
    const locations = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await runchiseClient.get("/locations", {
        params: { page, item_per_page: 100 },
      });
      const pageLocations = response.data?.locations;

      if (!Array.isArray(pageLocations)) {
        throw new Error("Tidak dapat menemukan semua locations");
      }

      locations.push(...pageLocations);
      const paging = response.data?.paging;
      hasMore = paging?.next_page
        ? true
        : Number.isFinite(Number(paging?.total_item))
          ? locations.length < Number(paging.total_item)
          : pageLocations.length === 100;
      page += 1;

      if (page > 100) {
        throw new Error("Jumlah halaman locations Runchise melebihi batas");
      }
    }

    return locations;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function listAllSubBrands() {
  try {
    const response = await runchiseClient.get("/sub_brands");
    const sub_brands = response.data.sub_brands;

    if (!Array.isArray(sub_brands)) {
      throw new Error("Tidak dapat menemukan semua sub brands");
    }

    return sub_brands;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function listSaleTransactionByCustomerId(runchise_customer_id) {
  try {
    if (!runchise_customer_id)
      throw new Error("Runchise Customer Id is required");

    let response = await runchiseClient.get(
      `/sale_transactions?customer_id=${runchise_customer_id}`,
    );

    let paging = response.data.paging;
    let sale_transactions = response.data.sale_transactions;

    while (paging.next_page) {
      response = await runchiseClient.get(paging.next_page);
      paging = response.data.paging;
      sale_transactions = [
        ...sale_transactions,
        ...response.data.sale_transactions,
      ];
    }

    return sale_transactions;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function syncProductsFromRunchise(runchise_product_ids) {
  try {
    if (
      !Array.isArray(runchise_product_ids) ||
      runchise_product_ids.length === 0
    ) {
      throw new Error("Runchise Product Ids is required");
    }

    let products = [];
    for (const products_id of runchise_product_ids) {
      const response = await runchiseClient.get(`/products/${products_id}`);
      const product = response.data.product;

      if (!product) {
        throw new Error(`Product with id ${products_id} not found`);
      }

      // Sync product to local database
      const syncedProduct = await prisma.product.upsert({
        where: { runchise_product_id: products_id },
        update: {
          name: product.name,
          price: product.price,
          stock: product.stock,
        },
        create: {
          runchise_product_id: products_id,
          name: product.name,
          price: product.price,
          stock: product.stock,
        },
      });

      products.push(syncedProduct);
    }

    return products;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function generateLoyaltyProducts() {
  try {
    const response = await runchiseClient.get(`/loyalties`);
    const loyalties = response.data.loyalties;

    if (!Array.isArray(loyalties)) {
      throw new Error("Tidak dapat menemukan semua loyalties");
    }

    // Selected loyalties is active
    const activeLoyalties = loyalties.filter((loyalty) => loyalty.is_active);

    const products = [];
    for (const loyalty_product of activeLoyalties.at(0)?.loyalty_products ??
      []) {
      const product_locations = await Promise.all(
        loyalty_product.product_locations.map(async (location) => {
          const productLocation = await prisma.location.findUnique({
            where: { runchise_id: location.id },
          });
          return productLocation?.location_id;
        }),
      );

      const location_ids = await Promise.all(
        loyalty_product.locations.map(async (location) => {
          const ownLocation = await prisma.location.findUnique({
            where: { runchise_id: location.id },
          });
          return ownLocation?.location_id;
        }),
      );

      const product_location_ids = product_locations.filter(Boolean);
      const location_ids_filtered = location_ids.filter(Boolean);

      const product = await prisma.loyaltyProduct.upsert({
        where: { runchise_loyalty_product_id: loyalty_product.id },
        update: {
          runchise_loyalty_product_id: loyalty_product.id,
          runchise_product_id: loyalty_product.product_id,
          point_needed: loyalty_product.point_needed,
          product_name: loyalty_product.product_name,
          product_sku: loyalty_product.product_sku,
          product_description: loyalty_product.product_description,
          product_image_url: loyalty_product.product_image_url,
          product_unit_name: loyalty_product.product_unit_name,
          max_redeem: loyalty_product.max_redeem,
          is_select_all_location: loyalty_product.is_select_all_location,
          location_ids: location_ids_filtered,
          product_location_ids: product_location_ids,
        },
        create: {
          runchise_loyalty_product_id: loyalty_product.id,
          runchise_product_id: loyalty_product.product_id,
          point_needed: loyalty_product.point_needed,
          product_name: loyalty_product.product_name,
          product_sku: loyalty_product.product_sku,
          product_description: loyalty_product.product_description,
          product_image_url: loyalty_product.product_image_url,
          product_unit_name: loyalty_product.product_unit_name,
          max_redeem: loyalty_product.max_redeem,
          is_select_all_location: loyalty_product.is_select_all_location,
          location_ids: location_ids_filtered,
          product_location_ids: product_location_ids,
        },
      });

      products.push(product);
    }

    return products;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function createPromo(payload) {
  try {
    const validate = createPromoSchema.safeParse(payload);

    if (!validate.success) {
      throw validate.error;
    }

    const data = validate.data;
    const result = await runchiseClient.post(`/promos`, data);

    return result.data?.promo ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function updatePromo(runchise_promo_id, payload) {
  try {
    const validate = updatePromoSchema.safeParse(payload);

    if (!validate.success) {
      throw validate.error;
    }

    const result = await runchiseClient.patch(
      `/promos/${runchise_promo_id}`,
      validate.data,
    );

    return result.data?.promo ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function deactivatePromo(runchise_promo_id) {
  try {
    const result = await runchiseClient.patch(
      `/promos/${runchise_promo_id}/deactivate`,
    );

    return result.status === 204 ? true : null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function activatePromo(runchise_promo_id) {
  try {
    const result = await runchiseClient.patch(
      `/promos/${runchise_promo_id}/activate`,
    );
    return result.status === 204 ? true : null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function generatePromoCode({ runchise_promo_id, total_code }) {
  try {
    const { z } = require("zod");
    const input = z
      .object({
        runchise_promo_id: z.number().int().positive(),
        total_code: z.number().int().min(1).max(1000),
      })
      .parse({ runchise_promo_id, total_code });
    total_code = input.total_code;
    const defaultLength = 7;
    const defaultMaxUsage = 1;

    const codes = [];
    const usedCodes = new Set();
    let attempts = 0;

    while (codes.length < total_code) {
      if (++attempts > total_code * 20) {
        throw new Error(
          "Gagal menghasilkan promo code unik dalam batas percobaan",
        );
      }
      const code = generateRandomUniqueCode(defaultLength);
      if (usedCodes.has(code)) continue;
      usedCodes.add(code);
      codes.push({
        code: code,
        maximum_usage: defaultMaxUsage,
      });
    }

    const payload = {
      source: "array",
      promo_codes: codes,
    };

    const response = await runchiseClient.post(
      `/promos/${runchise_promo_id}/promo_codes`,
      payload,
    );

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function getPromo(runchise_promo_id) {
  try {
    const response = await runchiseClient.get(`/promos/${runchise_promo_id}`);
    return response.data?.promo ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function getListPromoCodes(runchise_promo_id) {
  try {
    const response = await runchiseClient.get(
      `/promos/${runchise_promo_id}/promo_codes`,
    );

    const data = response.data.promo_codes;

    return data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

async function getListSaleTransactionSummary(last_id = null) {
  try {
    const location_ids = await findAllLocationIds();

    let sale_transactions = [];
    for (const location_id of location_ids) {
      try {
        const params = new URLSearchParams({
          location_id: String(location_id),
          ...(last_id ? { last_id } : {}),
        });
        const response = await runchiseClient.get(
          `/sale_transactions/summaries?${params}`,
        );

        const data = response.data.data;

        sale_transactions.push(...data);
      } catch (error) {
        console.log(
          `Gagal fetch sale transactions summary location ${location_id}:`,
          err.message,
        );
        continue;
      }
    }

    return sale_transactions;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code: "RUNCHISE_REQUEST_FAILED",
        statusCode: 502,
      });
    }
    throw error;
  }
}

module.exports = {
  findCustomerByPhone,
  createCustomer,
  updateCustomer,
  listAllLocations,
  listAllSubBrands,
  listSaleTransactionByCustomerId,
  syncProductsFromRunchise,
  generateLoyaltyProducts,
  createPromo,
  updatePromo,
  deactivatePromo,
  activatePromo,
  generatePromoCode,
  getListPromoCodes,
  getPromo,
  getListSaleTransactionSummary,
};
