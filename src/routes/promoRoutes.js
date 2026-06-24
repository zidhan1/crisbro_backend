const express = require('express');
const router = express.Router();

// Service untuk mengambil data promo dari Runchise
const { fetchAllPromos } = require('../services/runchiseService');

// Service untuk mapping sub-brand berdasarkan kategori
const { getSubBrandMapping } = require('../services/subBrandService');

// Sub-brand yang boleh ditampilkan
const VISIBLE_SUB_BRANDS = new Set(['Crisbar']);

// Default durasi promo jika tidak ada end_date
const DEFAULT_PROMO_LIFESPAN_DAYS = 90;

// Channel POS
const POS_CHANNEL = 'pos';

// ===================== HELPER FUNCTION =====================

// Normalisasi channel (lowercase + trim)
function normalizeChannel(rawChannel) {
  return String(rawChannel ?? '').trim().toLowerCase();
}

// Cek apakah promo dari channel POS
function isPosChannel(channel) {
  return normalizeChannel(channel) === POS_CHANNEL;
}

// Cek apakah promo dari channel online (bukan POS)
function isOnlineChannel(channel) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return false;
  return normalized !== POS_CHANNEL;
}

// Parsing tanggal format Runchise (dd/mm/yyyy)
function parseRunchiseDate(value, endOfDay = false) {
  if (!value) return null;

  const parts = String(value).split('/');
  if (parts.length !== 3) return null;

  const [day, month, year] = parts.map(Number);
  if (!day || !month || !year) return null;

  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

// Menambahkan hari ke tanggal
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Menentukan status promo berdasarkan tanggal & status asli
function getEffectiveStatus(promo, now) {
  const start = parseRunchiseDate(promo.start_date, false);
  let end = parseRunchiseDate(promo.end_date, true);

  if (promo.deleted) return 'inactive';

  if (!end && start) {
    end = addDays(start, DEFAULT_PROMO_LIFESPAN_DAYS);
  }

  if (end && end.getTime() < now.getTime()) return 'completed';
  if (start && start.getTime() > now.getTime()) return 'inactive';

  return promo.status || 'active';
}

// Menentukan sub-brand dari promo
function detectSubBrand(promo, categoryIdToSubBrand) {
  const rule = promo.promo_rule;
  if (!rule) return 'Crisbar';

  const ruleCategories = rule.product_categories ?? [];
  // Cek berdasarkan kategori produk
  for (const cat of ruleCategories) {
    const subBrand = categoryIdToSubBrand.get(cat.id);
    if (subBrand) return subBrand;
  }

  // Fallback berdasarkan nama produk
  const productNames = [
    ...(rule.products ?? []).map((p) => p.name),
    ...(promo.promo_reward?.get_products ?? []).map((p) => p.name),
  ];
  const lowerNames = productNames.map((n) => n.toLowerCase());

  if (lowerNames.some((n) => n.includes('jeong bok') || n.includes('bokki'))) {
    return 'Jeong Bok Chicken';
  }
  if (lowerNames.some((n) => n.includes('jaya') || n.includes('sambal'))) {
    return 'Green Jaya';
  }
  if (lowerNames.some((n) => n.includes('warkop'))) {
    return 'Warkop CBR';
  }

  return 'Crisbar';
}

// ===================== GET PROMOS =====================

// Endpoint untuk mengambil daftar promo
// GET /api/promos
router.get('/', async (req, res) => {
  try {
    // Ambil promo dari API + mapping sub-brand secara paralel
    const [promos, { categoryIdToSubBrand }] = await Promise.all([
      fetchAllPromos(),
      getSubBrandMapping(),
    ]);

    const now = new Date();

    // Transform data promo
    let result = promos.map((p) => {
      const isAllOutlets = p.is_select_all_location === true;
      const effectiveStatus = getEffectiveStatus(p, now);
      const subBrand = detectSubBrand(p, categoryIdToSubBrand);

      return {
        id: p.id,
        name: p.name,
        status: effectiveStatus,
        start_date: p.start_date,
        end_date: p.end_date ?? null,
        channel: p.channel ?? null,
        is_online_only: isOnlineChannel(p.channel),
        is_all_outlets: isAllOutlets,
        locations: isAllOutlets
          ? []
          : (p.locations ?? []).map((loc) => ({
              id: loc.id,
              name: loc.name,
            })),
        discount_amount: p.promo_reward?.discount_amount
          ? parseFloat(p.promo_reward.discount_amount)
          : null,
        discount_is_percentage: p.promo_reward?.discount_is_percentage ?? false,
        template: p.promo_reward?.template ?? null,
        _sub_brand: subBrand,
        _start: parseRunchiseDate(p.start_date, false),
        _is_pos_channel: isPosChannel(p.channel),
      };
    });

    // Filter promo yang tidak valid / tidak ingin ditampilkan
    result = result.filter((p) => p.status !== 'completed' && p.status !== 'inactive');
    result = result.filter((p) => VISIBLE_SUB_BRANDS.has(p._sub_brand));
    result = result.filter((p) => !p._is_pos_channel);

    // Sorting berdasarkan tanggal mulai terbaru
    result = result
      .sort((a, b) => (b._start?.getTime() ?? 0) - (a._start?.getTime() ?? 0))
      .map(({ _start, _sub_brand, _is_pos_channel, ...rest }) => rest);

    res.json(result);
  } catch (error) {
    console.error('Promo fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;