const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNCHISE_CRON_LOCK_NAMESPACE,
  withDistributedCronLock,
} = require('../src/lib/distributedCronLock');

function createMockClient({ acquired = true } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push(['query', sql, params]);
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired }] };
      }
      return { rows: [{ pg_advisory_unlock: true }] };
    },
    async end() {
      calls.push(['end']);
    },
  };
}

test('melewati job ketika advisory lock sedang dipegang instance lain', async () => {
  const client = createMockClient({ acquired: false });
  let jobCalls = 0;

  const result = await withDistributedCronLock({
    jobName: 'test:distributed-busy',
    lockId: 101,
    createClient: () => client,
    run: async () => {
      jobCalls += 1;
    },
  });

  assert.deepEqual(result, {
    skipped: true,
    reason: 'distributed_lock_busy',
    job: 'test:distributed-busy',
  });
  assert.equal(jobCalls, 0);
  assert.equal(
    client.calls.some(
      ([type, sql]) => type === 'query' && sql.includes('pg_advisory_unlock'),
    ),
    false,
  );
  assert.deepEqual(client.calls.at(-1), ['end']);
});

test('mutex lokal menolak overlap sebelum membuka koneksi database kedua', async () => {
  const firstClient = createMockClient();
  let resolveFirst;
  const firstRun = withDistributedCronLock({
    jobName: 'test:local-overlap',
    lockId: 102,
    createClient: () => firstClient,
    run: () => new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  let secondClientCreated = false;
  const secondResult = await withDistributedCronLock({
    jobName: 'test:local-overlap',
    lockId: 102,
    createClient: () => {
      secondClientCreated = true;
      return createMockClient();
    },
    run: async () => null,
  });

  assert.equal(secondClientCreated, false);
  assert.equal(secondResult.reason, 'local_lock_busy');
  resolveFirst({ ok: true });
  assert.deepEqual(await firstRun, { ok: true });
});

test('unlock memakai koneksi dan key yang sama walaupun job gagal', async () => {
  const client = createMockClient();

  await assert.rejects(
    withDistributedCronLock({
      jobName: 'test:failure',
      lockId: 103,
      createClient: () => client,
      run: async () => {
        throw new Error('job failed');
      },
    }),
    /job failed/,
  );

  const unlockCall = client.calls.find(
    ([type, sql]) => type === 'query' && sql.includes('pg_advisory_unlock'),
  );
  assert.deepEqual(unlockCall[2], [RUNCHISE_CRON_LOCK_NAMESPACE, 103]);
  assert.deepEqual(client.calls.at(-1), ['end']);

  // Mutex lokal juga harus bersih setelah error agar invocation berikutnya bisa jalan.
  const retryClient = createMockClient({ acquired: false });
  const retry = await withDistributedCronLock({
    jobName: 'test:failure',
    lockId: 103,
    createClient: () => retryClient,
    run: async () => null,
  });
  assert.equal(retry.reason, 'distributed_lock_busy');
});
