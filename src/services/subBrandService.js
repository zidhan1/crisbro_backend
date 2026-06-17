const { runchiseClient } = require('./runchiseService');

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

let cache = {
  data: null,
  expiresAt: 0,
};

const CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

async function getSubBrandMapping() {
  const now = Date.now();

  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const subBrands = await fetchAllSubBrandsRaw();

  const categoryIdToSubBrand = new Map();
  const categoryIdsBySubBrand = new Map();
  const subBrandNames = [];

  for (const sb of subBrands) {
    subBrandNames.push(sb.name);
    const key = normalizeName(sb.name);

    if (!categoryIdsBySubBrand.has(key)) {
      categoryIdsBySubBrand.set(key, new Set());
    }
    const idSet = categoryIdsBySubBrand.get(key);

    for (const cat of sb.product_categories ?? []) {
      idSet.add(cat.id);

      // categoryIdToSubBrand tetap "first sub-brand wins" seperti perilaku asli
      if (!categoryIdToSubBrand.has(cat.id)) {
        categoryIdToSubBrand.set(cat.id, sb.name);
      }
    }
  }

  const result = { categoryIdToSubBrand, categoryIdsBySubBrand, subBrandNames };

  cache = {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  };

  return result;
}

async function getCategoryIdsForSubBrand(subBrandName) {
  const { categoryIdsBySubBrand } = await getSubBrandMapping();
  return categoryIdsBySubBrand.get(normalizeName(subBrandName)) ?? new Set();
}

module.exports = {
  getSubBrandMapping,
  getCategoryIdsForSubBrand,
  fetchAllSubBrandsRaw,
};