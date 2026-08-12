const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bulkWritePosRewardRedemptions,
  serializeRedemptionRow,
} = require('../src/services/runchisePosRewardRedemptionService');

test('serializer redemption membuat Date aman untuk JSON bulk', () => {
  assert.equal(
    serializeRedemptionRow({
      redeemed_at: new Date('2026-08-12T05:00:00.000Z'),
      raw: undefined,
    }).redeemed_at,
    '2026-08-12T05:00:00.000Z',
  );
});

test('satu halaman POS redemption memakai satu transaksi dan dua bulk statement', async () => {
  let transactions = 0;
  const statements = [];
  const db = {
    async $transaction(run) {
      transactions++;
      return run({
        async $executeRaw(query) {
          statements.push(query);
          return 1;
        },
      });
    },
  };

  await bulkWritePosRewardRedemptions(
    db,
    [{ sale_transaction_id: 10, detail_ids: [101, 102] }],
    [{
      sale_transaction_id: 10,
      sale_detail_transaction_id: 101,
      redeemed_at: new Date('2026-08-12T05:00:00.000Z'),
    }],
  );
  assert.equal(transactions, 1);
  assert.equal(statements.length, 2);
});

test('halaman tanpa redemption tetap menjalankan bulk cleanup satu kali', async () => {
  let statements = 0;
  await bulkWritePosRewardRedemptions(
    {
      $transaction: (run) => run({ $executeRaw: async () => statements++ }),
    },
    [{ sale_transaction_id: 10, detail_ids: [] }],
    [],
  );
  assert.equal(statements, 1);
});

test('tanpa report tidak membuka transaksi', async () => {
  let transactions = 0;
  await bulkWritePosRewardRedemptions(
    { $transaction: async () => transactions++ },
    [],
    [],
  );
  assert.equal(transactions, 0);
});
