const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toRedemptionTrend,
  toPublicRedemptionHistory,
} = require('../src/lib/loyaltySummaryProjection');

test('proyeksi history tidak pernah mengekspos PII customer', () => {
  const rows = [
    {
      id: 10n,
      redeem_menu_item_id: 2,
      runchise_product_id: 3,
      product_name: 'Reward',
      quantity: '1.000',
      point_per_item: 100,
      points_spent: 100,
      selling_price: '12000.00',
      location_id: 101,
      location_name: 'Outlet A',
      redeemed_at: new Date('2026-08-01T10:00:00.000Z'),
      customer_id: 999,
      runchise_customer_id: 888,
      customer_name: 'Nama Rahasia',
      customer_phone_number: '081234567890',
    },
  ];

  const projected = toPublicRedemptionHistory(
    rows,
    new Map([[101, { id: 1, city: 'Bandung' }]]),
  );

  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, '10');
  assert.equal(projected[0].outlet_city, 'Bandung');
  assert.equal('customer_id' in projected[0], false);
  assert.equal('runchise_customer_id' in projected[0], false);
  assert.equal('customer_name' in projected[0], false);
  assert.equal('customer_phone_number' in projected[0], false);
});

test('hasil agregasi SQL dinormalisasi menjadi angka JSON dan tanggal harian', () => {
  const projected = toRedemptionTrend([
    {
      date: new Date('2026-08-01T00:00:00.000Z'),
      redemption_count: '4.5',
      points_spent: '900',
    },
  ]);

  assert.deepEqual(projected, [
    { date: '2026-08-01', redemption_count: 4.5, points_spent: 900 },
  ]);
});
