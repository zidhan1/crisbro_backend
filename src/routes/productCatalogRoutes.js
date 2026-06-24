const express = require('express');
const router = express.Router();

// Mengimpor service untuk mengambil data produk dari Runchise
const { fetchAllProducts } = require('../services/runchiseService');

// Mengambil daftar kategori berdasarkan sub-brand
const { getCategoryIdsForSubBrand } = require('../services/subBrandService');

// Konstanta mapping kategori Crisbar
const {
  CRISBAR_SUB_BRAND_NAME,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
} = require('../constants/categoryMapping');

// ===================== FILTER PRODUK YANG BOLEH DITAMPILKAN =====================

// Mengambil produk yang boleh ditampilkan untuk sub-brand Crisbar
async function getVisibleCrisbarProducts() {
  const [products, crisbarCategoryIds] = await Promise.all([
    fetchAllProducts(), // ambil semua produk dari API Runchise
    getCategoryIdsForSubBrand(CRISBAR_SUB_BRAND_NAME), // ambil kategori valid untuk Crisbar
  ]);

  // Jika kategori tidak ditemukan, tampilkan warning
  if (crisbarCategoryIds.size === 0) {
    console.warn(
      `Tidak menemukan kategori untuk sub-brand "${CRISBAR_SUB_BRAND_NAME}" dari Runchise. ` +
        'Cek nama sub-brand di API atau ketersediaan endpoint /sub_brands.',
    );
  }

  // Filter produk yang valid untuk ditampilkan
  return products.filter((p) => {
    if (p.status !== 'activated') return false; // hanya produk aktif

    const category = p.product_category;
    if (!category || category.id == null) return false;

    // hanya kategori yang sesuai sub-brand
    if (!crisbarCategoryIds.has(category.id)) return false;
    // exclude kategori tertentu
    if (EXCLUDED_CRISBAR_CATEGORY_NAMES.has(category.name)) return false;

    return true;
  });
}

// ===================== GET PRODUCTS =====================

// Endpoint untuk mendapatkan daftar produk
// GET /api/catalog/products
router.get('/', async (req, res) => {
  try {
    const { category_id } = req.query;

    // ambil produk yang sudah difilter
    let filtered = await getVisibleCrisbarProducts();

    // filter tambahan berdasarkan kategori jika ada
    if (category_id) {
      filtered = filtered.filter(
        (p) => String(p.product_category?.id) === String(category_id),
      );
    }

    // format data sebelum dikirim ke frontend
    const result = filtered.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      sell_price: Number(p.sell_price),
      image_url: p.image_url,
      category: p.product_category?.name,
      category_id: p.product_category?.id,
      sku: p.sku ?? null,
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== GET CATEGORIES =====================

// Endpoint untuk mendapatkan daftar kategori produk
// GET /api/catalog/products/categories
router.get('/categories', async (req, res) => {
  try {
    // ambil produk yang sudah difilter
    const filtered = await getVisibleCrisbarProducts();

    // mapping kategori agar tidak duplikat
    const categoryMap = new Map();

    filtered.forEach((p) => {
      const category = p.product_category;
      if (!category) return;

      // jika kategori belum ada, buat entry baru
      if (!categoryMap.has(category.id)) {
        categoryMap.set(category.id, {
          id: category.id,
          name: category.name,
          total_products: 0,
        });
      }

      // hitung jumlah produk per kategori
      categoryMap.get(category.id).total_products++;
    });

    // ubah Map menjadi array dan urutkan berdasarkan jumlah produk
    const categories = Array.from(categoryMap.values()).sort(
      (a, b) => b.total_products - a.total_products,
    );

    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;