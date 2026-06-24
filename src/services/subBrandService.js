// Mengimpor Runchise API client
const { runchiseClient } = require('./runchiseService');

// ===================== FETCH RAW DATA =====================

// Mengambil semua sub-brand dari Runchise (pagination otomatis)
async function fetchAllSubBrandsRaw() {
  let allSubBrands = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await runchiseClient.get('/sub_brands', {
      params: { page, item_per_page: 100 },
    });

    allSubBrands = allSubBrands.concat(data.sub_brands);
    hasMore = data.paging.next_page !== null;
    page++;
  }

  return allSubBrands;
}

// ===================== CACHE =====================

// Cache untuk mengurangi request ke API Runchise
let cache = {
  data: null,
  expiresAt: 0,
};

// TTL cache (5 menit)
const CACHE_TTL_MS = 5 * 60 * 1000;

// Normalisasi nama sub-brand (lowercase + trim)
function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// ===================== CORE LOGIC =====================

// Mengambil mapping sub-brand ke kategori dengan cache
async function getSubBrandMapping() {
  const now = Date.now();

  // Jika cache masih valid, pakai data lama
  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  // Ambil data sub-brand dari API
  const subBrands = await fetchAllSubBrandsRaw();

  // Mapping struktur data
  const categoryIdToSubBrand = new Map(); // categoryId → subBrandName
  const categoryIdsBySubBrand = new Map(); // subBrandName → Set(categoryId)
  const subBrandNames = [];

  for (const sb of subBrands) {
    subBrandNames.push(sb.name);
    const key = normalizeName(sb.name);

    if (!categoryIdsBySubBrand.has(key)) {
      categoryIdsBySubBrand.set(key, new Set());
    }
    const idSet = categoryIdsBySubBrand.get(key);

    // Mapping kategori per sub-brand
    for (const cat of sb.product_categories ?? []) {
      idSet.add(cat.id);

      // first match wins (tidak overwrite mapping lama)
      if (!categoryIdToSubBrand.has(cat.id)) {
        categoryIdToSubBrand.set(cat.id, sb.name);
      }
    }
  }

  // Hasil akhir mapping
  const result = { categoryIdToSubBrand, categoryIdsBySubBrand, subBrandNames };

  // Simpan ke cache
  cache = {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  };

  return result;
}

// ===================== HELPER =====================

// Mengambil semua category ID untuk sub-brand tertentu
async function getCategoryIdsForSubBrand(subBrandName) {
  const { categoryIdsBySubBrand } = await getSubBrandMapping();
  return categoryIdsBySubBrand.get(normalizeName(subBrandName)) ?? new Set();
}

// Mengekspor fungsi agar bisa dipakai di service lain
module.exports = {
  getSubBrandMapping,
  getCategoryIdsForSubBrand,
  fetchAllSubBrandsRaw,
};