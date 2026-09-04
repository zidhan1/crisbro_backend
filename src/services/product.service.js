const prisma = require("../lib/prisma");
const { generateLoyaltyProducts } = require("./runchise.service");

async function syncLoyaltyProducts() {
  try {
    const loyaltyProducts = await generateLoyaltyProducts();
    return loyaltyProducts;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function deleteLoyaltyProduct(loyalty_product_id) {
  try {
    const deletedProduct = await prisma.loyaltyProduct.delete({
      where: { loyalty_product_id: loyalty_product_id },
    });

    return deletedProduct;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function listLoyaltyProducts({ query, take, skip } = {}) {
  try {
    const where = query
      ? {
          OR: [
            { product_name: { contains: query } },
            { product_sku: { contains: query } },
          ],
        }
      : undefined;

    const [total, loyalty_products] = await prisma.$transaction([
      prisma.loyaltyProduct.count({ where }),
      prisma.loyaltyProduct.findMany({
        where,
        take,
        skip,
        orderBy: { product_name: "asc" },
      }),
    ]);

    return {
      total,
      total_page: take ? Math.ceil(total / take) : 1,
      loyalty_products,
    };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

module.exports = {
  syncLoyaltyProducts,
  deleteLoyaltyProduct,
  listLoyaltyProducts,
};
