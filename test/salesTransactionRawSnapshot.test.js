const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSaleRewardRedemptionSnapshot,
  mapSalesTransactionReportData,
} = require('../src/services/syncService');
const {
  extractRewardRedemptions,
  unwrapSale,
} = require('../src/services/runchisePosRewardRedemptionService');

// M-9: Menambahkan pengujian untuk memastikan hanya field transaksi yang diperlukan disimpan sehingga ukuran data berkurang tanpa mengubah hasil ekstraksi reward redemption.

function buildBloatedSale({ loyaltyContainer = 'metadata' } = {}) {
  // Field "bloat" ini sengaja dibuat besar dan sama sekali tidak relevan
  // dengan redemption, meniru field asli respons /sale_transactions Runchise
  // yang tidak pernah dibaca oleh extractRewardRedemptions()/unwrapSale().
  const bloat = {
    tax_breakdown: Array.from({ length: 50 }, (_, i) => ({
      tax_id: i,
      tax_name: `Pajak ${i}`,
      tax_rate: 0.11,
      tax_amount: 1000 + i,
      description: 'x'.repeat(200),
    })),
    discount_breakdown: Array.from({ length: 30 }, (_, i) => ({
      discount_id: i,
      discount_name: `Diskon ${i}`,
      notes: 'y'.repeat(200),
    })),
    staff: { id: 99, name: 'Kasir Contoh', shift_history: 'z'.repeat(2000) },
    table_info: { id: 5, name: 'Meja 5', floor_plan_svg: 'w'.repeat(2000) },
    full_product_catalog: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `Produk ${i}`,
      description: 'v'.repeat(200),
    })),
  };

  const loyaltyPayload = {
    redeemed_point: 50,
    loyalty_products: [
      {
        product_id: 111,
        point_needed: 50,
        name: 'Kopi Gratis',
        extra_notes: 'u'.repeat(500),
      },
    ],
  };

  const saleDetail = {
    id: 9001,
    product_id: 111,
    product_name: 'Kopi Gratis',
    price: 0,
    quantity: 1,
    cancelled_quantity: 0,
    deleted: false,
    meta: { sell_price: 25000, unrelated_bloat_field: 't'.repeat(500) },
    unrelated_detail_bloat: 's'.repeat(500),
  };

  return {
    id: 162656087,
    customer_id: 555,
    customer_name: 'Budi',
    customer_phone_number: '81234567890',
    customer_phone_number_country_code: 62,
    location_id: 4453,
    location_name: 'Outlet Contoh',
    sales_time: '2026-07-15T10:00:00+07:00',
    local_sales_time: '2026-07-15T17:00:00+07:00',
    sales_no: 'SN-001',
    receipt_no: 'RC-001',
    status: 'closed',
    deleted: false,
    net_sales_after_tax: 25000,
    payments: [
      { amount_receive: 25000, change: 0, payment_method_name: 'cash' },
    ],
    sale_detail_transactions: [saleDetail],
    metadata: {
      available_point: 100,
      total_point: 100,
      earned_point: 0,
      redeemed_point: loyaltyContainer === 'metadata_top' ? 50 : undefined,
      loyalty: loyaltyContainer === 'metadata' ? loyaltyPayload : undefined,
      ...bloat,
    },
    loyalty: loyaltyContainer === 'sale' ? loyaltyPayload : undefined,
    ...bloat,
  };
}

test('buildSaleRewardRedemptionSnapshot memangkas field yang tidak pernah dibaca ulang', () => {
  const sale = buildBloatedSale({ loyaltyContainer: 'metadata' });
  const fullSize = JSON.stringify(sale).length;

  const snapshot = buildSaleRewardRedemptionSnapshot(sale);
  const snapshotSize = JSON.stringify(snapshot).length;

  // Blob yang disimpan harus jauh lebih kecil -- ini yang diklaim finding
  // M-9 belum tuntas, sekarang terukur lewat perbandingan ukuran nyata.
  assert.ok(
    snapshotSize < fullSize * 0.2,
    `snapshot (${snapshotSize} byte) harus < 20% ukuran sale asli (${fullSize} byte)`,
  );

  // Field bloat tidak boleh ikut tersimpan sama sekali.
  const snapshotJson = JSON.stringify(snapshot);
  for (const bloatField of [
    'tax_breakdown',
    'discount_breakdown',
    'shift_history',
    'floor_plan_svg',
    'full_product_catalog',
    'unrelated_bloat_field',
    'unrelated_detail_bloat',
  ]) {
    assert.equal(
      snapshotJson.includes(bloatField),
      false,
      `field bloat "${bloatField}" seharusnya tidak ada di snapshot`,
    );
  }

  // Field yang memang dipakai tetap ada dan benar nilainya.
  assert.equal(snapshot.id, sale.id);
  assert.equal(snapshot.customer_id, sale.customer_id);
  assert.equal(snapshot.customer_name, sale.customer_name);
  assert.equal(snapshot.metadata.loyalty.loyalty_products[0].product_id, 111);
  assert.equal(snapshot.sale_detail_transactions[0].product_id, 111);
  assert.equal(snapshot.sale_detail_transactions[0].meta.sell_price, 25000);
});

test('mapSalesTransactionReportData menulis raw yang sudah dipangkas, bukan sale mentah', () => {
  const sale = buildBloatedSale({ loyaltyContainer: 'metadata' });
  const data = mapSalesTransactionReportData(sale, null, null, 4453);

  assert.ok(data.raw);
  assert.notEqual(data.raw, sale);
  assert.equal(JSON.stringify(data.raw).includes('tax_breakdown'), false);
  assert.deepEqual(data.raw, buildSaleRewardRedemptionSnapshot(sale));
});

const loyaltyContainerPaths = {
  metadata: 'sale.metadata.loyalty',
  sale: 'sale.loyalty',
};
for (const loyaltyContainer of Object.keys(loyaltyContainerPaths)) {
  test(`extractRewardRedemptions menghasilkan hasil identik dari raw penuh vs raw dipangkas (loyalty di ${loyaltyContainerPaths[loyaltyContainer]})`, () => {
    const sale = buildBloatedSale({ loyaltyContainer });
    const snapshot = buildSaleRewardRedemptionSnapshot(sale);

    const baseReport = {
      runchise_sales_transaction_id: sale.id,
      runchise_customer_id: sale.customer_id,
      customer_id: 42,
      nama_pelanggan: 'Budi',
      no_telepon: '6281234567890',
      runchise_location_id: sale.location_id,
      source_location_id: sale.location_id,
      nama_outlet: sale.location_name,
      tanggal_transaksi: new Date(sale.sales_time),
      penggunaan_poin: 50,
    };

    const fromFullRaw = extractRewardRedemptions(
      { ...baseReport, raw: sale },
      new Map(),
    );
    const fromTrimmedRaw = extractRewardRedemptions(
      { ...baseReport, raw: snapshot },
      new Map(),
    );

    // M-9: Memastikan seluruh data penting untuk reward redemption tetap konsisten, sementara perubahan pada data audit (raw) diverifikasi secara terpisah agar pengurangan ukuran data tidak memengaruhi fungsionalitas.
    const stripEmbeddedRaw = (result) => ({
      ...result,
      rows: result.rows.map(({ raw, ...row }) => row),
    });
    assert.deepEqual(
      stripEmbeddedRaw(fromTrimmedRaw),
      stripEmbeddedRaw(fromFullRaw),
    );
    assert.equal(fromTrimmedRaw.valid, fromFullRaw.valid);
    assert.equal(fromTrimmedRaw.calculatedPoints, fromFullRaw.calculatedPoints);
    assert.equal(fromTrimmedRaw.redeemedPoints, fromFullRaw.redeemedPoints);

    assert.equal(fromTrimmedRaw.valid, true);
    assert.equal(fromTrimmedRaw.rows.length, 1);
    assert.equal(fromTrimmedRaw.rows[0].runchise_product_id, 111);
    assert.equal(fromTrimmedRaw.rows[0].points_spent, 50);

    // Blob audit yang tersimpan di redemption row juga ikut lebih kecil saat
    // sumbernya sudah dipangkas -- bukti bloat tidak menyelinap lewat sini.
    assert.equal(
      JSON.stringify(fromTrimmedRaw.rows[0].raw).includes(
        'unrelated_detail_bloat',
      ),
      false,
    );
    assert.equal(
      JSON.stringify(fromFullRaw.rows[0].raw).includes(
        'unrelated_detail_bloat',
      ),
      true,
    );
  });
}

test('unwrapSale tetap bekerja normal untuk raw yang sudah dipangkas (tidak ada wrapper sale_transaction)', () => {
  const sale = buildBloatedSale({ loyaltyContainer: 'metadata' });
  const snapshot = buildSaleRewardRedemptionSnapshot(sale);

  assert.equal(unwrapSale(snapshot), snapshot);
  assert.equal(unwrapSale(snapshot).id, sale.id);
});

test('buildSaleRewardRedemptionSnapshot aman untuk input kosong/invalid', () => {
  assert.equal(buildSaleRewardRedemptionSnapshot(null), null);
  assert.equal(buildSaleRewardRedemptionSnapshot(undefined), null);
  assert.equal(buildSaleRewardRedemptionSnapshot('not-an-object'), null);

  const minimal = buildSaleRewardRedemptionSnapshot({ id: 1 });
  assert.equal(minimal.id, 1);
  assert.equal(minimal.loyalty, null);
  assert.equal(minimal.metadata, null);
  assert.deepEqual(minimal.sale_detail_transactions, []);
});
