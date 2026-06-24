// Label untuk menampilkan semua kategori menu
const CRISBRO_REDEEM_ALL_LABEL = 'Semua';

// Nama kategori utama menu Crisbro
const CRISBRO_REDEEM_MENU_CATEGORY_NAME = 'Menu Crisbro';

// Daftar kategori beserta menu yang dapat diredeem
const CRISBRO_REDEEM_MENU_CATEGORIES = [
  {
    name: CRISBRO_REDEEM_MENU_CATEGORY_NAME,
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

// Mengambil daftar nama semua kategori
const CRISBRO_REDEEM_CATEGORY_NAMES = CRISBRO_REDEEM_MENU_CATEGORIES.map(
  (category) => category.name.trim(),
);

// Mengambil kategori yang benar-benar memiliki daftar menu
const CRISBRO_REDEEM_ITEM_CATEGORIES = CRISBRO_REDEEM_MENU_CATEGORIES.filter(
  (category) => Array.isArray(category.items) && category.items.length > 0,
);

// Mengambil nama kategori yang memiliki menu
const CRISBRO_REDEEM_ITEM_CATEGORY_NAMES = CRISBRO_REDEEM_ITEM_CATEGORIES.map(
  (category) => category.name.trim(),
);
// Menyamakan format nama menu agar mudah dibandingkan (trim, hapus spasi berlebih, huruf kecil)
function normalizeMenuName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Membuat Map untuk pencarian menu secara cepat berdasarkan nama menu
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

// Mengekspor konstanta dan fungsi agar dapat digunakan di file lain
module.exports = {
  CRISBRO_REDEEM_ALL_LABEL,
  CRISBRO_REDEEM_MENU_CATEGORY_NAME,
  CRISBRO_REDEEM_MENU_CATEGORIES,
  CRISBRO_REDEEM_CATEGORY_NAMES,
  CRISBRO_REDEEM_ITEM_CATEGORIES,
  CRISBRO_REDEEM_ITEM_CATEGORY_NAMES,
  buildCrisbroRedeemMenuLookup,
  normalizeMenuName,
};
