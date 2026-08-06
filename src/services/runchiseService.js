// Mengimpor axios untuk melakukan HTTP request ke API eksternal
const axios = require('axios');

function getBoundedInteger(name, fallback, { min = 0, max }) {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const RUNCHISE_REQUEST_TIMEOUT_MS = getBoundedInteger(
  'RUNCHISE_API_TIMEOUT_MS',
  6000,
  { min: 1000, max: 8000 },
);
const RUNCHISE_MAX_RETRIES = getBoundedInteger(
  'RUNCHISE_API_MAX_RETRIES',
  1,
  { min: 0, max: 2 },
);
const RUNCHISE_MAX_PAGES = getBoundedInteger('RUNCHISE_API_MAX_PAGES', 100, {
  min: 1,
  max: 1000,
});

// Membuat instance axios khusus untuk API Runchise
const runchiseClient = axios.create({
  baseURL: 'https://api.runchise.com/api/public',
  timeout: RUNCHISE_REQUEST_TIMEOUT_MS,
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

function getRetryBudgetMs(retries = RUNCHISE_MAX_RETRIES) {
  const effectiveRetries = Math.min(
    Math.max(0, retries),
    RUNCHISE_MAX_RETRIES,
  );
  const backoffMs = Array.from(
    { length: effectiveRetries },
    (_, attempt) => 500 * 2 ** attempt,
  ).reduce((total, delay) => total + delay, 0);
  return (effectiveRetries + 1) * RUNCHISE_REQUEST_TIMEOUT_MS + backoffMs;
}

function assertPageWithinLimit(resource, page, maxPages = RUNCHISE_MAX_PAGES) {
  if (page > maxPages) {
    const error = new Error(
      `Pagination ${resource} melewati batas aman ${maxPages} halaman`,
    );
    error.code = 'RUNCHISE_MAX_PAGES_EXCEEDED';
    error.resource = resource;
    error.page = page;
    error.maxPages = maxPages;
    throw error;
  }
}

async function requestWithRetry(
  label,
  request,
  { retries = RUNCHISE_MAX_RETRIES } = {},
) {
  let lastError;
  const effectiveRetries = Math.min(
    Math.max(0, retries),
    RUNCHISE_MAX_RETRIES,
  );

  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;

      if (!isTransientRunchiseError(error) || attempt === effectiveRetries) {
        break;
      }

      const delayMs = 500 * 2 ** attempt;
      console.warn(
        `${label} gagal sementara (${error.code || error.response?.status || error.message}), retry ${attempt + 1}/${effectiveRetries}`,
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

const RUNCHISE_PAGE_SIZE = 100;
const RUNCHISE_SALES_TRANSACTIONS_PATH =
  process.env.RUNCHISE_SALES_TRANSACTIONS_PATH || '/sale_transactions';

async function fetchCustomersPage(locationId, page) {
  const { data } = await requestWithRetry(
    `Fetch customers Runchise page ${page}`,
    () =>
      runchiseClient.get(`/locations/${locationId}/customers`, {
        params: { page, item_per_page: RUNCHISE_PAGE_SIZE },
      }),
  );

  return data;
}

// Mengambil semua customer dari Runchise (pagination otomatis)
async function fetchAllCustomers(locationId) {
  let allCustomers = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    assertPageWithinLimit('customers', page);
    const data = await fetchCustomersPage(locationId, page);

    allCustomers = allCustomers.concat(data.customers);
    hasMore = data.paging.next_page !== null;
    page++;
  }

  return allCustomers;
}

// Mengambil customer dari seluruh outlet yang dapat diakses API lalu
// menggabungkannya berdasarkan ID customer Runchise. Customer dapat terdaftar
// di beberapa outlet, sehingga nomor telepon tidak aman dijadikan kunci.
async function fetchAllCustomersAcrossLocations() {
  const locations = await fetchAllLocations();
  const locationIds = [
    ...new Set(
      locations
        .map((location) => Number(location.id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  // Tetap dukung instalasi yang belum dapat membaca endpoint locations, tapi
  // hanya bila ada outlet pengganti yang ditentukan secara eksplisit. Fallback
  // lama ke ID 1 menunjuk outlet yang tidak dimiliki Crisbar, sehingga sync
  // tampak sukses padahal tidak memproses satu customer pun.
  if (locationIds.length === 0) {
    const fallbackLocationId = Number(process.env.RUNCHISE_SYNC_LOCATION_ID);

    if (!Number.isInteger(fallbackLocationId) || fallbackLocationId <= 0) {
      throw new Error(
        'Tidak ada lokasi Runchise yang dapat dibaca dan RUNCHISE_SYNC_LOCATION_ID belum diisi',
      );
    }

    locationIds.push(fallbackLocationId);
  }

  const customerById = new Map();

  // Sengaja sekuensial agar satu request dashboard tidak membanjiri API
  // Runchise ketika akun mempunyai banyak outlet.
  for (const locationId of locationIds) {
    const customers = await fetchAllCustomers(locationId);
    for (const customer of customers) {
      const customerId = Number(customer.id);
      if (Number.isInteger(customerId) && customerId > 0) {
        const existing = customerById.get(customerId);
        customerById.set(customerId, {
          ...(existing ?? {}),
          ...customer,
          location_ids: [
            ...new Set([
              ...(existing?.location_ids ?? []),
              ...(customer.location_ids ?? []),
            ].map(Number).filter((id) => Number.isInteger(id) && id > 0)),
          ],
        });
      }
    }
  }

  return [...customerById.values()];
}

// Daftar location_id tempat customer Runchise terdaftar, termasuk outlet
// pemiliknya.
function getCustomerLocationIds(customer) {
  return [
    ...new Set(
      [Number(customer?.owner_location_id), ...(customer?.location_ids ?? [])]
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
}

// Endpoint customer menerima filter phone_number, sehingga pencocokan nomor
// cukup satu request. Tanpa filter ini paging berhenti di halaman 100 (API
// selalu melaporkan total_item 10000 per outlet), jadi satu pencarian nomor
// yang tidak ketemu memakan 100 request per outlet.
//
// Dua sifat filter ini wajib diperhatikan:
// 1. Tidak dibatasi lokasi pada path — hasilnya bisa customer outlet lain.
// 2. Bila nomornya tidak ada, API tetap mengembalikan customer lain yang tidak
//    berhubungan, bukan daftar kosong.
// Karena itu hasilnya selalu diverifikasi ulang di sini.
async function lookupCustomersByPhone(locationId, normalizedPhone) {
  const { data } = await requestWithRetry(
    `Cari customer Runchise dengan nomor ${normalizedPhone}`,
    () =>
      runchiseClient.get(`/locations/${locationId}/customers`, {
        params: {
          page: 1,
          item_per_page: RUNCHISE_PAGE_SIZE,
          phone_number: normalizedPhone,
        },
      }),
  );

  return (data?.customers ?? []).filter(
    (customer) =>
      normalizeIndonesianPhone(customer.phone_number) === normalizedPhone,
  );
}

// Mencari customer berdasarkan nomor HP di satu outlet
async function findCustomerByPhone(locationId, phoneNumber) {
  const normalizedPhone = normalizeIndonesianPhone(phoneNumber);
  if (!normalizedPhone) return null;

  const targetLocationId = Number(locationId);
  const matches = await lookupCustomersByPhone(targetLocationId, normalizedPhone);

  return (
    matches.find((customer) =>
      getCustomerLocationIds(customer).includes(targetLocationId),
    ) ?? null
  );
}

// ===================== SALES TRANSACTIONS =====================

function extractSalesTransactions(data) {
  if (Array.isArray(data)) return data;

  return (
    data.sales_transactions ||
    data.sale_transactions ||
    data.transactions ||
    data.data ||
    []
  );
}

async function fetchSalesTransactionsPage(page, params = {}) {
  const { data } = await requestWithRetry(
    `Fetch sales transactions Runchise page ${page}`,
    () =>
      runchiseClient.get(RUNCHISE_SALES_TRANSACTIONS_PATH, {
        params: {
          page,
          item_per_page: RUNCHISE_PAGE_SIZE,
          ...params,
        },
      }),
  );

  return data;
}

async function fetchAllSalesTransactions(params = {}) {
  let allTransactions = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    assertPageWithinLimit('sales transactions', page);
    const data = await fetchSalesTransactionsPage(page, params);
    const pageTransactions = extractSalesTransactions(data);

    allTransactions = allTransactions.concat(pageTransactions);

    if (data.paging?.next_page !== undefined) {
      hasMore = data.paging.next_page !== null;
    } else if (data.paging?.total_item !== undefined) {
      hasMore = allTransactions.length < data.paging.total_item;
    } else {
      hasMore = pageTransactions.length === RUNCHISE_PAGE_SIZE;
    }

    page++;
  }

  return allTransactions;
}

// Filter phone_number berlaku lintas outlet, jadi satu request sudah mewakili
// seluruh lokasi. Versi lama memindai setiap lokasi halaman demi halaman
// (32 outlet x 100 halaman = ~3.200 request, belasan menit per customer baru).
async function findCustomerByPhoneAcrossLocations(phoneNumber, excludedLocationId = null) {
  const normalizedPhone = normalizeIndonesianPhone(phoneNumber);
  if (!normalizedPhone) return null;

  const excludedId = Number(excludedLocationId);
  const hasExcludedId = Number.isInteger(excludedId) && excludedId > 0;
  // Path lokasi hanya menentukan alamat endpoint, bukan cakupan pencarian.
  const lookupLocationId = hasExcludedId
    ? excludedId
    : (await fetchAllLocations())
        .map((location) => Number(location.id))
        .find((id) => Number.isInteger(id) && id > 0);

  if (!lookupLocationId) return null;

  const matches = await lookupCustomersByPhone(lookupLocationId, normalizedPhone);

  for (const customer of matches) {
    const otherLocationId = getCustomerLocationIds(customer).find(
      (id) => !hasExcludedId || id !== excludedId,
    );

    if (otherLocationId) {
      return { customer, location_id: otherLocationId };
    }
  }

  return null;
}

// ===================== PRODUCTS =====================

async function fetchProductsPage({ page = 1, itemPerPage = 50, status } = {}) {
  const params = { page, item_per_page: itemPerPage };
  if (status) params.status = status;

  const { data } = await requestWithRetry(
    `Fetch products Runchise page ${page}`,
    () => runchiseClient.get('/products', { params }),
  );

  if (!Array.isArray(data?.products) || !data?.paging) {
    throw new Error(`Response products halaman ${page} tidak valid`);
  }

  return data;
}

// Mengambil semua produk dari Runchise (pagination otomatis)
async function fetchAllProducts() {
  let allProducts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    assertPageWithinLimit('products', page);
    const data = await fetchProductsPage({
      page,
      itemPerPage: 100,
      status: 'activated',
    });

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
    assertPageWithinLimit('sub brands', page);
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
    assertPageWithinLimit('locations', page);
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

async function fetchPromosPage({ page = 1, itemPerPage = 50 } = {}) {
  const { data } = await requestWithRetry(
    `Fetch promos Runchise page ${page}`,
    () =>
      runchiseClient.get('/promos', {
        params: { page, item_per_page: itemPerPage },
      }),
    { retries: 3 },
  );

  if (!Array.isArray(data?.promos) || !data?.paging) {
    throw new Error(`Response promos halaman ${page} tidak valid`);
  }

  return data;
}

// Mengambil semua promo dari Runchise
async function fetchAllPromos() {
  let allPromos = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    assertPageWithinLimit('promos', page);
    const data = await fetchPromosPage({ page, itemPerPage: 100 });

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
  RUNCHISE_REQUEST_TIMEOUT_MS,
  RUNCHISE_MAX_RETRIES,
  RUNCHISE_MAX_PAGES,
  getRetryBudgetMs,
  assertPageWithinLimit,
  requestWithRetry,
  fetchCustomersPage,
  fetchAllCustomers,
  fetchAllCustomersAcrossLocations,
  fetchAllSalesTransactions,
  findCustomerByPhone,
  findCustomerByPhoneAcrossLocations,
  normalizeIndonesianPhone,
  fetchProductsPage,
  fetchAllProducts,
  fetchAllSubBrands,
  fetchAllLocations,
  fetchPromosPage,
  fetchAllPromos,
  createCustomer,
  updateCustomer,
  runchiseClient,
};
