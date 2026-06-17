const { runchiseClient } = require('./runchiseService');

// ── Ambil semua sub_brands dengan pagination otomatis ──
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

async function getSubBrandMapping() {
  const now = Date.now();

  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const subBrands = await fetchAllSubBrandsRaw();

  const categoryIdToSubBrand = new Map();
  const subBrandNames = [];

  for (const sb of subBrands) {
    subBrandNames.push(sb.name);
    for (const cat of sb.product_categories ?? []) {
      if (!categoryIdToSubBrand.has(cat.id)) {
        categoryIdToSubBrand.set(cat.id, sb.name);
      }
    }
  }

  const result = { categoryIdToSubBrand, subBrandNames };

  cache = {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  };

  return result;
}

module.exports = { getSubBrandMapping, fetchAllSubBrandsRaw };
