const prisma = require("../lib/prisma");
const { listAllSubBrands } = require("./runchise.service");

function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

async function generateSubBrandsRunchise() {
  const sub_brands = await listAllSubBrands();

  const brands = [];
  if (Array.isArray(sub_brands)) {
    for (const brand of sub_brands) {
      const exist = await prisma.subBrand.findFirst({
        where: { runchise_id: brand.id },
      });

      if (exist) continue;

      brands.push({
        runchise_id: brand.id ?? null,
        name: brand.name ?? "Unknow Brand",
        image_url: brand.image_url ?? null,
        location_type: brand.location_type ?? null,
        is_select_all_location: brand.is_select_all_location ?? null,
        enable_online_order: brand.enable_online_order ?? null,
      });
    }
  }

  if (brands.length === 0)
    return {
      code: 200,
      message: "Sub brand not found in runchise or already imported",
    };

  const result = await prisma.subBrand.createMany({
    data: brands,
    skipDuplicates: true,
  });

  return {
    code: 200,
    data: result,
    message: "Sub brands success imported to database.",
  };
}

async function listSubBrandsService() {
  return prisma.subBrand.findMany({
    orderBy: [{ name: "asc" }, { sub_brand_id: "asc" }],
  });
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
  generateSubBrandsRunchise,
  listSubBrandsService,
};
