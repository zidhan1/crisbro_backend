const CRISBRO_REDEEM_MENU_CATEGORIES = [
  {
    name: 'Menu Crisbro',
    items: [],
  },
  {
    name: 'Mood Booster Drinks',
    items: [
      'Lychee Tea',
      'Lemon tea',
      'Sweet Iced tea',
      'Air Mineral',
      'Fondue Chocolate',
    ],
  },
  {
    name: 'Snack & Sides',
    items: [
      'Vanilla Ice Cream',
      'chicken skin crisbar',
      'Snack Jamur Crispy',
      'cireng bumbu rujak',
      'swicy fries',
    ],
  },
  {
    name: 'Crisbar Coffe',
    items: ['ice americano', 'es kopi fighter'],
  },
  {
    name: 'Survival Kit',
    items: ['jamur crispy balado', 'jamur crispy keju salju'],
  },
  {
    name: 'Cocolove Series',
    items: ['Coconut Blush'],
  },
];

const CRISBRO_REDEEM_CATEGORY_NAMES = CRISBRO_REDEEM_MENU_CATEGORIES.map(
  (category) => category.name.trim(),
);

const CRISBRO_REDEEM_ITEM_CATEGORIES = CRISBRO_REDEEM_MENU_CATEGORIES.filter(
  (category) => Array.isArray(category.items) && category.items.length > 0,
);

const CRISBRO_REDEEM_ITEM_CATEGORY_NAMES = CRISBRO_REDEEM_ITEM_CATEGORIES.map(
  (category) => category.name.trim(),
);

function normalizeMenuName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildCrisbroRedeemMenuLookup() {
  const lookup = new Map();

  CRISBRO_REDEEM_ITEM_CATEGORIES.forEach((category, categoryIndex) => {
    category.items.forEach((itemName, itemIndex) => {
      lookup.set(normalizeMenuName(itemName), {
        displayName: itemName,
        categoryName: category.name.trim(),
        categoryIndex,
        itemIndex,
      });
    });
  });

  return lookup;
}

module.exports = {
  CRISBRO_REDEEM_MENU_CATEGORIES,
  CRISBRO_REDEEM_CATEGORY_NAMES,
  CRISBRO_REDEEM_ITEM_CATEGORIES,
  CRISBRO_REDEEM_ITEM_CATEGORY_NAMES,
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
};
