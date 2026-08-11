const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bulkWriteSalesTransactionReports,
  serializeSalesReportRow,
} = require('../src/services/syncService');

test('serializer bulk aman untuk Date, BigInt, Decimal-like, dan null', () => {
  const row = serializeSalesReportRow({
    tanggal_transaksi: new Date('2026-08-11T05:00:00.000Z'),
    import_run_id: 12n,
    nominal_transaksi: { toNumber: () => 50000.25 },
    optional: undefined,
  });
  assert.deepEqual(row, {
    tanggal_transaksi: '2026-08-11T05:00:00.000Z',
    import_run_id: '12',
    nominal_transaksi: 50000.25,
    optional: null,
  });
});

test('satu halaman memakai satu transaksi dan maksimal dua bulk statement', async () => {
  let transactionCount = 0;
  const statements = [];
  const db = {
    async $transaction(run) {
      transactionCount++;
      return run({
        async $executeRaw(query) {
          statements.push(query);
          return 1;
        },
      });
    },
  };
  await bulkWriteSalesTransactionReports(
    db,
    [
      {
        source_location_id: 1001,
        runchise_sales_transaction_id: 10,
        penambahan_poin: 5,
        penggunaan_poin: 0,
        raw: { id: 10 },
      },
      {
        source_location_id: 1001,
        runchise_sales_transaction_id: 11,
        penambahan_poin: 7,
        penggunaan_poin: 0,
        raw: { id: 11 },
      },
    ],
    [
      {
        source_location_id: 1001,
        runchise_sales_transaction_id: 12,
      },
    ],
  );
  assert.equal(transactionCount, 1);
  assert.equal(statements.length, 2);
});

test('halaman kosong tidak membuka transaksi database', async () => {
  let transactionCount = 0;
  await bulkWriteSalesTransactionReports(
    { $transaction: async () => transactionCount++ },
    [],
    [],
  );
  assert.equal(transactionCount, 0);
});

test('kegagalan bulk statement diteruskan agar cursor tidak maju', async () => {
  const db = {
    async $transaction(run) {
      return run({
        async $executeRaw() {
          throw new Error('bulk write gagal');
        },
      });
    },
  };
  await assert.rejects(
    bulkWriteSalesTransactionReports(
      db,
      [{ source_location_id: 1001, runchise_sales_transaction_id: 10 }],
      [],
    ),
    /bulk write gagal/,
  );
});
