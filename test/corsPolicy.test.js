const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { createCorsPolicy } = require('../src/lib/corsPolicy');
const { cookieOptions } = require('../src/lib/sessionCookie');

async function startPolicyServer(policy) {
  const app = express();
  app.use(policy.guard);
  app.use(cors(policy.corsOptions));
  app.post('/api/login', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('production login preflight accepts canonical frontend without env configuration', async (t) => {
  const policy = createCorsPolicy({ nodeEnv: 'production', frontendUrl: '', corsOrigins: '' });
  const { server, url } = await startPolicyServer(policy);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://crisbro-frontend.vercel.app',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://crisbro-frontend.vercel.app');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('production CORS rejects untrusted and lookalike origins', async (t) => {
  const policy = createCorsPolicy({ nodeEnv: 'production' });
  const { server, url } = await startPolicyServer(policy);
  t.after(() => server.close());

  for (const origin of [
    'https://evil.example',
    'https://crisbro-frontend.vercel.app.evil.example',
  ]) {
    const response = await fetch(`${url}/api/login`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('production session cookie defaults to cross-site compatible secure settings', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSameSite = process.env.SESSION_COOKIE_SAME_SITE;
  process.env.NODE_ENV = 'production';
  delete process.env.SESSION_COOKIE_SAME_SITE;
  try {
    const options = cookieOptions();
    assert.equal(options.sameSite, 'none');
    assert.equal(options.secure, true);
    assert.equal(options.httpOnly, true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSameSite === undefined) delete process.env.SESSION_COOKIE_SAME_SITE;
    else process.env.SESSION_COOKIE_SAME_SITE = previousSameSite;
  }
});
