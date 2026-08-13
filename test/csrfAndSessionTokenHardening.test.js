const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const csrfProtection = require('../src/middleware/csrfProtection');
const { hashSessionToken } = require('../src/lib/sessionToken');

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('hash token sesi deterministik dan tidak menyimpan JWT mentah', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  const expected = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(hashSessionToken(token), expected);
  assert.equal(hashSessionToken(token).length, 64);
  assert.doesNotMatch(hashSessionToken(token), /eyJ/);
});

test('mutasi dengan cookie tanpa header CSRF ditolak', () => {
  const req = {
    method: 'POST',
    headers: { cookie: 'crisbar_session=jwt-mentah' },
    get(name) { return this.headers[name.toLowerCase()]; },
  };
  const res = responseMock();
  let continued = false;
  csrfProtection(req, res, () => { continued = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
});

test('mutasi cookie dengan header CSRF dan request tanpa cookie diteruskan', () => {
  for (const headers of [
    { cookie: 'crisbar_session=jwt', 'x-csrf-protection': '1' },
    {},
  ]) {
    const req = {
      method: 'POST',
      headers,
      get(name) { return this.headers[name.toLowerCase()]; },
    };
    let continued = false;
    csrfProtection(req, responseMock(), () => { continued = true; });
    assert.equal(continued, true);
  }
});

test('request GET dengan cookie tidak membutuhkan header CSRF', () => {
  const req = {
    method: 'GET',
    headers: { cookie: 'crisbar_session=jwt' },
    get(name) { return this.headers[name.toLowerCase()]; },
  };
  let continued = false;
  csrfProtection(req, responseMock(), () => { continued = true; });
  assert.equal(continued, true);
});
