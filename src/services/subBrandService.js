const prisma = require('../lib/prisma');

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

async function getSubBrandMapping() {
  const links = await prisma.subBrandProductCategory.findMany({
    include: {
      sub_brand: {
        select: { name: true },
      },
      menu_category: {
        select: { id: true },
      },
    },
  });

  const categoryIdToSubBrand = new Map();
  const categoryIdsBySubBrand = new Map();
  const subBrandNames = [];
  const seenSubBrandNames = new Set();

  for (const link of links) {
    const subBrandName = link.sub_brand.name;
    const key = normalizeName(subBrandName);
    const categoryId = link.menu_category.id;

    if (!seenSubBrandNames.has(key)) {
      seenSubBrandNames.add(key);
      subBrandNames.push(subBrandName);
    }

    if (!categoryIdsBySubBrand.has(key)) {
      categoryIdsBySubBrand.set(key, new Set());
    }

    categoryIdsBySubBrand.get(key).add(categoryId);

    if (!categoryIdToSubBrand.has(categoryId)) {
      categoryIdToSubBrand.set(categoryId, subBrandName);
    }
  }

  return { categoryIdToSubBrand, categoryIdsBySubBrand, subBrandNames };
}

async function getCategoryIdsForSubBrand(subBrandName) {
  const { categoryIdsBySubBrand } = await getSubBrandMapping();
  return categoryIdsBySubBrand.get(normalizeName(subBrandName)) ?? new Set();
}

module.exports = {
  getSubBrandMapping,
  getCategoryIdsForSubBrand,
};
