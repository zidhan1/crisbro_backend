const prisma = require("../lib/prisma");
const dotenv = require("dotenv");
const axios = require("axios");
const {
  createCustomerSchema,
} = require("../validation/runchise/runchise-validation");

dotenv.config();

const runchiseClient = axios.create({
  baseURL: "https://api.runchise.com/api/public",
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

    console.log(sale_transactions);
    return sale_transactions;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

module.exports = {
  findCustomerByPhone,
  createCustomer,
  listAllLocations,
  listAllSubBrands,
  listSaleTransactionByCustomerId,
};
