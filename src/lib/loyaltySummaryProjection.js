// M-4 (lanjutan): query tren kini mengembalikan label hari WIB yang sudah jadi
// berupa TEXT 'YYYY-MM-DD', sehingga tidak ada Date yang perlu diformat ulang
// dengan zona runtime. Cabang Date dipertahankan sebagai jaring pengaman untuk
// pemanggil lain (dan test) yang masih menyerahkan objek Date.
function toRedemptionTrendDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

function toRedemptionTrend(rows) {
  return rows.map((row) => ({
    date: toRedemptionTrendDate(row.date),
    redemption_count: Number(row.redemption_count),
    points_spent: Number(row.points_spent),
  }));
}

function toPublicRedemptionHistory(rows, locationByRunchiseId) {
  return rows.map((redemption) => {
    const location = locationByRunchiseId.get(redemption.location_id);
    return {
      id: String(redemption.id),
      reward_id: redemption.redeem_menu_item_id,
      runchise_product_id: redemption.runchise_product_id,
      reward_name: redemption.product_name,
      quantity: Number(redemption.quantity),
      point_per_item: redemption.point_per_item,
      points_spent: redemption.points_spent,
      menu_price: Number(redemption.selling_price),
      outlet_id: location?.id ?? null,
      runchise_location_id: redemption.location_id,
      outlet_name: redemption.location_name ?? 'Outlet tidak diketahui',
      outlet_city: location?.city ?? null,
      redeemed_at: redemption.redeemed_at,
    };
  });
}

module.exports = {
  toRedemptionTrend,
  toRedemptionTrendDate,
  toPublicRedemptionHistory,
};
