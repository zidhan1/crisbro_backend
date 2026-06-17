const CRISBAR_SUB_BRAND_NAME = 'Crisbar';

// Tambahkan ke sini hanya kategori yang sifatnya operasional/internal
// (option set, bahan baku, promo internal, dsb), bukan kategori display produk.
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
]);

module.exports = { CRISBAR_SUB_BRAND_NAME, EXCLUDED_CRISBAR_CATEGORY_NAMES };