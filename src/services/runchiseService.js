// Mengimpor axios untuk melakukan HTTP request ke API eksternal
const axios = require('axios');

// Membuat instance axios khusus untuk API Runchise
const runchiseClient = axios.create({
  baseURL: 'https://api.runchise.com/api/public',
  timeout: Number(process.env.RUNCHISE_API_TIMEOUT_MS || 30000),
  headers: {
    Accept: 'application/json',
    Authorization: process.env.RUNCHISE_API_KEY,
    'Content-Type': 'application/json',
  },
});

// ===================== UTIL =====================

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRunchiseError(error) {
  const status = error.response?.status;

  return (
    TRANSIENT_NETWORK_CODES.has(error.code) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

async function requestWithRetry(label, request, { retries = 2 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;

      if (!isTransientRunchiseError(error) || attempt === retries) {
        break;
      }

      const delayMs = 500 * 2 ** attempt;
      console.warn(
        `${label} gagal sementara (${error.code || error.response?.status || error.message}), retry ${attempt + 1}/${retries}`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// Normalisasi nomor HP Indonesia (hapus 0 / 62 / karakter non-digit)
function normalizeIndonesianPhone(raw) {
  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function formatRunchisePhone(raw, countryCode = 62) {
  const normalizedPhone = normalizeIndonesianPhone(raw);
  if (!normalizedPhone) return null;

  return normalizedPhone;
}

function formatRunchiseDate(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
}

function getRunchiseErrorMessage(error) {
  const errorData = error.response?.data;

  if (errorData?.errors) {
    return JSON.stringify(errorData.errors);
  }

  return errorData?.message || error.message || 'Gagal menghubungi Runchise';
}

function buildCustomerPayload(locationId, customerData) {
  const phoneNumberCountryCode = Number(
    customerData.phone_number_country_code ?? 62,
  );

  return {
    name: customerData.name,
    phone_number: formatRunchisePhone(
      customerData.phone_number,
      phoneNumberCountryCode,
    ),
    address: customerData.address || '',
    phone_number_country_code: phoneNumberCountryCode,
    city: customerData.city || '',
    gender: customerData.gender || 'unknown',
    dob: formatRunchiseDate(customerData.dob),
    email: customerData.email || null,
    province: customerData.province || '',
    country: customerData.country || 'Indonesia',
    postal_code: customerData.postal_code || '',
    owner_location_id: Number(customerData.owner_location_id ?? locationId),
  };
}

// ===================== CUSTOMERS =====================

// Mengambil semua customer dari Runchise (pagination otomatis)
async function fetchAllCustomers(locationId) {
  let allCustomers = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await requestWithRetry(
      `Fetch customers Runchise page ${page}`,
      () =>
        runchiseClient.get(`/locations/${locationId}/customers`, {
          params: { page, item_per_page: 100 },
        }),
    );

    allCustomers = allCustomers.concat(data.customers);
    hasMore = data.paging.next_page !== null;
    page++;
  }

  return allCustomers;
}

// Mencari customer berdasarkan nomor HP
async function findCustomerByPhone(locationId, phoneNumber) {
  const normalizedPhone = normalizeIndonesianPhone(phoneNumber);
  if (!normalizedPhone) return null;

  const customers = await fetchAllCustomers(locationId);

  return (
    customers.find(
      (customer) =>
        normalizeIndonesianPhone(customer.phone_number) === normalizedPhone,
    ) || null
  );
}

// ===================== PRODUCTS =====================

// Mengambil semua produk dari Runchise (pagination otomatis)
async function fetchAllProducts() {
  let allProducts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await requestWithRetry(
      `Fetch products Runchise page ${page}`,
      () =>
        runchiseClient.get('/products', {
          params: { page, item_per_page: 100, status: 'activated' },
        }),
    );

    allProducts = allProducts.concat(data.products);
    hasMore = data.paging.next_page !== null;
    page++;
  }

  return allProducts;
}

// ===================== SUB BRANDS =====================

// Mengambil semua sub-brand dari Runchise
async function fetchAllSubBrands() {
  let allSubBrands = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await requestWithRetry(
      `Fetch sub brands Runchise page ${page}`,
      () =>
        runchiseClient.get('/sub_brands', {
          params: {
            page,
            item_per_page: 100,
          },
        }),
    );

    // Gabungkan data sub-brand
    allSubBrands = allSubBrands.concat(data.sub_brands);

    // Cek apakah masih ada halaman berikutnya
    hasMore = data.paging.next_page !== null;
    page++;
  }

  return allSubBrands;
}

// ===================== LOCATIONS =====================

// Mengambil semua lokasi dari Runchise
async function fetchAllLocations() {
  let allLocations = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await requestWithRetry(
      `Fetch locations Runchise page ${page}`,
      () =>
        runchiseClient.get('/locations', {
          params: { page, item_per_page: 100 },
        }),
    );

    allLocations = allLocations.concat(data.locations);

    // Karena API pakai total_item, bukan next_page
    const totalFetched = allLocations.length;
    hasMore = totalFetched < data.paging.total_item;
    page++;
  }

  return allLocations;
}

// ===================== PROMOS =====================

// Mengambil semua promo dari Runchise
async function fetchAllPromos() {
  let allPromos = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await requestWithRetry(
      `Fetch promos Runchise page ${page}`,
      () =>
        runchiseClient.get('/promos', {
          params: { page, item_per_page: 100 },
        }),
    );

    allPromos = allPromos.concat(data.promos);
    hasMore = data.paging.next_page !== null;
    page++;
  }

  return allPromos;
}

// ===================== CREATE CUSTOMER =====================

// Membuat customer baru di Runchise
async function createCustomer(locationId, customerData) {
  try {
    const { data } = await runchiseClient.post(
      `/locations/${locationId}/customers`,
      buildCustomerPayload(locationId, customerData),
    );
    return data;
  } catch (error) {
    console.error(
      'Gagal membuat customer di Runchise:',
      getRunchiseErrorMessage(error),
    );

    throw new Error(getRunchiseErrorMessage(error));
  }
}

async function updateCustomer(locationId, customerId, customerData) {
  try {
    const { data } = await requestWithRetry(
      `Update customer Runchise ${customerId}`,
      () =>
        runchiseClient.patch(
          `/locations/${locationId}/customers/${customerId}`,
          buildCustomerPayload(locationId, customerData),
        ),
    );
    return data;
  } catch (error) {
    console.error(
      'Gagal mengupdate customer di Runchise:',
      getRunchiseErrorMessage(error),
    );

    throw new Error(getRunchiseErrorMessage(error));
  }
}

module.exports = {
  fetchAllCustomers,
  findCustomerByPhone,
  normalizeIndonesianPhone,
  fetchAllProducts,
  fetchAllSubBrands,
  fetchAllLocations,
  fetchAllPromos,
  createCustomer,
  updateCustomer,
  runchiseClient,
};
