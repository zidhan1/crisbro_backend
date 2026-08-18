const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSkipGlobalLimiter } = require('../src/lib/rateLimit');

test('login memakai limiter autentikasi khusus, bukan kuota API global', () => {
  for (const path of [
    '/api/login',
    '/api/register',
    '/api/activate',
    '/login',
    '/register',
    '/activate',
  ]) {
    assert.equal(shouldSkipGlobalLimiter({ path }), true, path);
  }
});

test('endpoint private biasa tetap dilindungi limiter global', () => {
  assert.equal(shouldSkipGlobalLimiter({ path: '/api/profile' }), false);
  assert.equal(shouldSkipGlobalLimiter({ path: '/profile' }), false);
  assert.equal(shouldSkipGlobalLimiter({ path: '/api/admin/users' }), false);
  assert.equal(shouldSkipGlobalLimiter({ path: '/api/cron/maintenance' }), true);
  assert.equal(shouldSkipGlobalLimiter({ path: '/cron/maintenance' }), true);
});
