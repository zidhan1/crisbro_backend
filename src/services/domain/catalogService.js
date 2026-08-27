// Catalog Service - Product catalog business logic
const prisma = require('../../lib/prisma');
const {
  CRISBAR_SUB_BRAND_NAME,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
} = require('../../constants/categoryMapping');

// ===================== PRODUCT QUERIES =====================

/**
 * Get all visible Crisbar products with filtering
 * @param {Object} filters - Filter parameters
 * @returns {Promise<Array>} Array of products
 */
async function getVisibleProducts(filters = {}) {
  const { category_id } = filters;

  // Build the base query
  const whereClause = {
    is_active: true,
    is_selectable: true,
    category: {
      name: { notIn: Array.from(EXCLUDED_CRISBAR_CATEGORY_NAMES) },
      sub_brand_links: {
        some: {
          sub_brand: {
            name: CRISBAR_SUB_BRAND_NAME,
          },
        },
      },
    },
  };

  // Add category filter if provided
  if (category_id) {
    whereClause.category_id = Number(category_id);
  }

  const items = await prisma.menuItem.findMany({
    where: whereClause,
    include: {
      category: {
        select: { id: true, name: true },
      },
    },
    orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
  });

  return items;
}

/**
 * Get product by ID
 * @param {number} productId - The product ID
 * @returns {Promise<Object|null>} The product or null if not found
 */
async function getProductById(productId) {
  const product = await prisma.menuItem.findFirst({
    where: {
      id: Number(productId),
      is_active: true,
      is_selectable: true,
      category: {
        name: { notIn: Array.from(EXCLUDED_CRISBAR_CATEGORY_NAMES) },
        sub_brand_links: {
          some: {
            sub_brand: {
              name: CRISBAR_SUB_BRAND_NAME,
            },
          },
        },
      },
    },
    include: {
      category: {
        select: { id: true, name: true },
      },
    },
  });

  return product;
}

/**
 * Get products by category
 * @param {number} categoryId - The category ID
 * @returns {Promise<Array>} Array of products in the category
 */
async function getProductsByCategory(categoryId) {
  return getVisibleProducts({ category_id: categoryId });
}

// ===================== PRODUCT TRANSFORMATION =====================

/**
 * Transform database product to API response format
 * @param {Object} product - The product from database
 * @returns {Object} Formatted product for API response
 */
function formatProductForAPI(product) {
  if (!product) return null;

  return {
    id: product.runchise_id ?? product.id,
    name: product.name,
    description: product.description,
    sell_price: Number(product.price),
    image_url: product.image_url,
    category: product.category?.name,
    category_id: product.category_id,
    sku: product.runchise_id ? `RUNCHISE-${product.runchise_id}` : null,
  };
}

/**
 * Transform multiple products to API response format
 * @param {Array} products - Array of products from database
 * @returns {Array} Formatted products for API response
 */
function formatProductsForAPI(products) {
  return products.map(formatProductForAPI).filter(Boolean);
}

// ===================== CATEGORY QUERIES =====================

/**
 * Get all product categories with product counts
 * @returns {Promise<Array>} Array of categories with product counts
 */
async function getProductCategories() {
  const items = await getVisibleProducts();
  const categoryMap = new Map();

  for (const item of items) {
    if (!item.category) continue;

    if (!categoryMap.has(item.category_id)) {
      categoryMap.set(item.category_id, {
        id: item.category_id,
        name: item.category.name,
        total_products: 0,
      });
    }

    categoryMap.get(item.category_id).total_products++;
  }

  // Convert to array and sort by product count (descending)
  const categories = Array.from(categoryMap.values()).sort(
    (a, b) => b.total_products - a.total_products,
  );

  return categories;
}

/**
 * Get category by ID
 * @param {number} categoryId - The category ID
 * @returns {Promise<Object|null>} The category or null if not found
 */
async function getCategoryById(categoryId) {
  const categories = await getProductCategories();
  return categories.find(cat => cat.id === Number(categoryId)) || null;
}

// ===================== EXPORTS =====================

module.exports = {
  // Product queries
  getVisibleProducts,
  getProductById,
  getProductsByCategory,

  // Product transformation
  formatProductForAPI,
  formatProductsForAPI,

  // Category queries
  getProductCategories,
  getCategoryById,
};