const test = require('node:test');
const assert = require('node:assert/strict');
test('C-1: worker customer hanya memproses job yang sudah diantrikan', async () => {
  process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = 'true';
  const { processCustomerImportSyncJob } = require('../src/services/customerImportSyncService');
  let insertCalls = 0;
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes('INSERT')) insertCalls++;
      return { rows: [] };
    },
  };
  const result = await processCustomerImportSyncJob({}, { createClient: () => client });
  assert.equal(result.status, 'idle');
  assert.equal(insertCalls, 0);
});
