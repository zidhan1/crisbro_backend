// Mengimpor axios untuk melakukan HTTP request ke API eksternal
const axios = require('axios');

// Membuat instance axios khusus untuk API Runchise
const runchiseClient = axios.create({
  baseURL: 'https://api.runchise.com/api/public',
  headers: {
    Accept: 'application/json',
    Authorization: process.env.RUNCHISE_API_KEY,
    'Content-Type': 'application/json',
  },
});

// ===================== UTIL =====================

// Normalisasi nomor HP Indonesia (hapus 0 / 62 / karakter non-digit)
function normalizeIndonesianPhone(raw) {
  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// ===================== CUSTOMERS =====================

// Mengambil semua customer dari Runchise (pagination otomatis)
async function fetchAllCustomers(locationId) {
  let allCustomers = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await runchiseClient.get(
      `/locations/${locationId}/customers`,
      {
        params: { page, item_per_page: 100 },
      },
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
    const { data } = await runchiseClient.get('/products', {
      params: { page, item_per_page: 100, status: 'activated' },
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
    const { data } = await runchiseClient.get('/sub_brands', {
      params: {
        page,
        item_per_page: 100,
      },
    });

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
    const { data } = await runchiseClient.get('/locations', {
      params: { page, item_per_page: 100 },
    });

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
    const { data } = await runchiseClient.get('/promos', {
      params: { page, item_per_page: 100 },
    });

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
    // Sesuai dokumentasi/kebutuhan API Runchise kamu biasanya dikirim ke endpoint lokasinya
    const { data } = await runchiseClient.post(
      `/locations/${locationId}/customers`,
      {
        name: customerData.name,
        phone_number: customerData.phone_number,
        email: customerData.email || null,
        status: 'active',
        phone_number_country_code: 62,
      },
    );
    return data;
  } catch (error) {
    // Mengambil pesan error dari server Runchise dengan aman
    const errorData = error.response?.data;
    console.error(
      'Gagal membuat customer di Runchise:',
      errorData || error.message,
    );

    // Jika Runchise mengirimkan pesan error spesifik (seperti nomor sudah terdaftar)
    if (errorData && errorData.errors) {
      throw new Error(JSON.stringify(errorData.errors));
    }

    throw new Error(errorData?.message || error.message);
  }
}

module.exports = {
  fetchAllCustomers,
  findCustomerByPhone,
  fetchAllProducts,
  fetchAllSubBrands,
  fetchAllLocations,
  fetchAllPromos,
  createCustomer,
  runchiseClient,
};
