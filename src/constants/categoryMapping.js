const CRISBAR_SUB_BRAND_NAME = 'Crisbar';

// Kategori operasional/internal, bukan kategori display produk
const EXCLUDED_CRISBAR_CATEGORY_NAMES = new Set([
  'Bahan Baku',
  'Option Set',
  'QPON',
  'BIG ORDER',
  'TikTok GO Tokopedia',
  'Bounceback and WA Delivery',
  'Exclusive on GoFood',
  'Tebus Murah',
  "Bookki's Recommendation",
  'Exclusive On ShopeeFood',
  'Komplimen Customer',
  'Option',
  'MERCHANDISE',
  'Landing Page Kampus',
  'Raos Pisan',
]);

module.exports = { CRISBAR_SUB_BRAND_NAME, EXCLUDED_CRISBAR_CATEGORY_NAMES };
