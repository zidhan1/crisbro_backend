const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const prisma = require('../src/lib/prisma');
const {
  resendActivationTargetLimiter,
  runchiseSyncTargetLimiter,
} = require('../src/lib/rateLimit');

function startTestServer() {
  const app = express();
  app.post(
    '/customers/:id/activation',
    resendActivationTargetLimiter,
    (req, res) => res.json({ called: true }),
  );
  app.post(
    '/customers/:id/runchise-sync',
    runchiseSyncTargetLimiter,
    (req, res) => res.json({ called: true }),
  );

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(server, path) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
  });
  return {
    status: response.status,
    body: await response.json(),
    limit: response.headers.get('ratelimit-limit'),
    remaining: response.headers.get('ratelimit-remaining'),
    retryAfter: response.headers.get('retry-after'),
  };
}

test('limiter efek samping terpisah dan berbasis target customer', async (t) => {
  const originalQueryRaw = prisma.$queryRaw;
  const counters = new Map();
  prisma.$queryRaw = async (strings, ...values) => {
    const key = values[0];
    const hits = (counters.get(key) ?? 0) + 1;
    counters.set(key, hits);
    return [{ hits, expires_at: new Date(Date.now() + 15 * 60 * 1000) }];
  };

  const server = await startTestServer();
  t.after(() => {
    prisma.$queryRaw = originalQueryRaw;
    server.close();
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await post(server, '/customers/101/activation');
    assert.equal(response.status, 200);
    assert.equal(response.limit, '3');
  }

  const blockedActivation = await post(server, '/customers/101/activation');
  assert.equal(blockedActivation.status, 429);
  assert.match(blockedActivation.body.message, /pengiriman aktivasi/);
  assert.ok(Number(blockedActivation.retryAfter) > 0);

  // ID "0101" harus memakai target yang sama dengan "101", agar format ID
  // tidak dapat dipakai untuk melewati kuota.
  const normalizedTarget = await post(server, '/customers/0101/activation');
  assert.equal(normalizedTarget.status, 429);

  // Customer dan endpoint lain memiliki kuota independen.
  const otherCustomer = await post(server, '/customers/102/activation');
  assert.equal(otherCustomer.status, 200);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await post(server, '/customers/101/runchise-sync');
    assert.equal(response.status, 200);
    assert.equal(response.limit, '5');
  }

  const blockedSync = await post(server, '/customers/101/runchise-sync');
  assert.equal(blockedSync.status, 429);
  assert.match(blockedSync.body.message, /sinkronisasi/);
});
