// Redeem Menu Service - Redeem menu business logic
const prisma = require('../../lib/prisma');

// ===================== REDEEM MENU QUERIES =====================

/**
 * Get all active redeem menu items
 * @param {Object} filters - Optional filter parameters
 * @returns {Promise<Array>} Array of redeem menu items
 */
async function getActiveRedeemMenuItems(filters = {}) {
  const { category_id } = filters;
  const now = new Date();

  const whereClause = {
    is_active: true,
    menu_item: {
      is_active: true,
      is_selectable: true,
    },
    category: {
      is_active: true,
    },
    OR: [{ start_at: null }, { start_at: { lte: now } }],
    AND: [{ OR: [{ end_at: null }, { end_at: { gte: now } }] }],
  };

  // Add category filter if provided
  if (category_id !== undefined) {
    whereClause.category_id = Number(category_id);
  }

  const items = await prisma.redeemMenuItem.findMany({
    where: whereClause,
    select: {
      id: true,
      points_required: true,
      badge: true,
      sort_order: true,
      category: {
        select: {
          id: true,
          name: true,
        },
      },
      menu_item: {
        select: {
          id: true,
          runchise_id: true,
          name: true,
          description: true,
          image_url: true,
          is_active: true,
        },
      },
    },
    orderBy: [
      { category: { sort_order: 'asc' } },
      { sort_order: 'asc' },
      { id: 'asc' },
    ],
  });

  return items;
}

/**
 * Get redeem menu item by ID
 * @param {number} itemId - The redeem menu item ID
 * @returns {Promise<Object|null>} The redeem menu item or null if not found
 */
async function getRedeemMenuItemById(itemId) {
  const now = new Date();

  const item = await prisma.redeemMenuItem.findFirst({
    where: {
      id: Number(itemId),
      is_active: true,
      menu_item: {
        is_active: true,
        is_selectable: true,
      },
      category: {
        is_active: true,
      },
      OR: [{ start_at: null }, { start_at: { lte: now } }],
      AND: [{ OR: [{ end_at: null }, { end_at: { gte: now } }] }],
    },
    select: {
      id: true,
      points_required: true,
      badge: true,
      sort_order: true,
      category: {
        select: {
          id: true,
          name: true,
        },
      },
      menu_item: {
        select: {
          id: true,
          runchise_id: true,
          name: true,
          description: true,
          image_url: true,
          is_active: true,
        },
      },
    },
  });

  return item;
}

/**
 * Get redeem menu items by category
 * @param {number} categoryId - The category ID
 * @returns {Promise<Array>} Array of redeem menu items in the category
 */
async function getRedeemMenuItemsByCategory(categoryId) {
  return getActiveRedeemMenuItems({ category_id: categoryId });
}

/**
 * Get all redeem menu categories
 * @returns {Promise<Array>} Array of categories with item counts
 */
async function getRedeemMenuCategories() {
  const items = await getActiveRedeemMenuItems();
  const categoryMap = new Map();

  for (const item of items) {
    if (!item.category) continue;

    if (!categoryMap.has(item.category.id)) {
      categoryMap.set(item.category.id, {
        id: item.category.id,
        name: item.category.name,
        total_items: 0,
        min_points: Infinity,
        max_points: 0,
      });
    }

    const category = categoryMap.get(item.category.id);
    category.total_items++;
    category.min_points = Math.min(category.min_points, item.points_required);
    category.max_points = Math.max(category.max_points, item.points_required);
  }

  // Convert to array and handle categories with no items
  const categories = Array.from(categoryMap.values())
    .map(cat => ({
      ...cat,
      min_points: cat.min_points === Infinity ? 0 : cat.min_points,
    }))
    .sort((a, b) => a.id - b.id);

  return categories;
}

// ===================== REDEEM MENU TRANSFORMATION =====================

/**
 * Transform database redeem menu item to API response format
 * @param {Object} item - The redeem menu item from database
 * @returns {Object} Formatted redeem menu item for API response
 */
function formatRedeemMenuItemForAPI(item) {
  if (!item || !item.menu_item) return null;

  return {
    id: item.id,
    sku: item.menu_item.runchise_id
      ? `RUNCHISE-${item.menu_item.runchise_id}`
      : `MENU-${item.menu_item.id}`,
    name: item.menu_item.name,
    description: item.menu_item.description,
    points_required: item.points_required,
    image_url: item.menu_item.image_url,
    category: item.category.name,
    category_id: item.category.id,
    badge: item.badge,
    sort_order: item.sort_order,
  };
}

/**
 * Transform multiple redeem menu items to API response format
 * @param {Array} items - Array of redeem menu items from database
 * @returns {Array} Formatted redeem menu items for API response
 */
function formatRedeemMenuItemsForAPI(items) {
  return items.map(formatRedeemMenuItemForAPI).filter(Boolean);
}

/**
 * Get redeem menu summary by points range
 * @param {number} minPoints - Minimum points
 * @param {number} maxPoints - Maximum points
 * @returns {Promise<Array>} Array of redeem menu items in points range
 */
async function getRedeemMenuItemsByPointsRange(minPoints, maxPoints) {
  const items = await getActiveRedeemMenuItems();

  return items
    .filter(item => item.points_required >= minPoints && item.points_required <= maxPoints)
    .map(formatRedeemMenuItemForAPI)
    .filter(Boolean);
}

/**
 * Get affordable redeem menu items for customer points
 * @param {number} customerPoints - Customer's available points
 * @returns {Promise<Array>} Array of affordable redeem menu items
 */
async function getAffordableRedeemMenuItems(customerPoints) {
  return getRedeemMenuItemsByPointsRange(0, customerPoints);
}

/**
 * Get redeem menu item statistics
 * @returns {Promise<Object>} Statistics about redeem menu items
 */
async function getRedeemMenuStats() {
  const items = await getActiveRedeemMenuItems();

  if (items.length === 0) {
    return {
      total_items: 0,
      min_points_required: 0,
      max_points_required: 0,
      avg_points_required: 0,
      categories: await getRedeemMenuCategories(),
    };
  }

  const points = items.map(item => item.points_required);
  const categories = await getRedeemMenuCategories();

  return {
    total_items: items.length,
    min_points_required: Math.min(...points),
    max_points_required: Math.max(...points),
    avg_points_required: Math.round(points.reduce((a, b) => a + b, 0) / points.length),
    categories,
  };
}

// ===================== EXPORTS =====================

module.exports = {
  // Redeem menu queries
  getActiveRedeemMenuItems,
  getRedeemMenuItemById,
  getRedeemMenuItemsByCategory,
  getRedeemMenuCategories,
  getRedeemMenuItemsByPointsRange,
  getAffordableRedeemMenuItems,
  getRedeemMenuStats,

  // Redeem menu transformation
  formatRedeemMenuItemForAPI,
  formatRedeemMenuItemsForAPI,
};