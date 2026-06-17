const express = require('express');
const router = express.Router();
const { fetchAllPromos } = require('../services/runchiseService');
const { getSubBrandMapping } = require('../services/subBrandService');

const VISIBLE_SUB_BRANDS = new Set(['Crisbar']);

const DEFAULT_PROMO_LIFESPAN_DAYS = 90;

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

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

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

function detectSubBrand(promo, categoryIdToSubBrand) {
  const rule = promo.promo_rule;
  if (!rule) return 'Crisbar';

  const ruleCategories = rule.product_categories ?? [];
  for (const cat of ruleCategories) {
    const subBrand = categoryIdToSubBrand.get(cat.id);
    if (subBrand) return subBrand;
  }

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

// GET /api/promos
router.get('/', async (req, res) => {
  try {
    const [promos, { categoryIdToSubBrand }] = await Promise.all([
      fetchAllPromos(),
      getSubBrandMapping(),
    ]);

    const now = new Date();

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
      };
    });

    result = result.filter((p) => p.status !== 'completed' && p.status !== 'inactive');
    result = result.filter((p) => VISIBLE_SUB_BRANDS.has(p._sub_brand));

    result = result
      .sort((a, b) => (b._start?.getTime() ?? 0) - (a._start?.getTime() ?? 0))
      .map(({ _start, _sub_brand, ...rest }) => rest);

    res.json(result);
  } catch (error) {
    console.error('Promo fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;