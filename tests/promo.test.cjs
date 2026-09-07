const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const ID = '550e8400-e29b-41d4-a716-446655440000';
function load(file, deps) {
  const filename = path.join(ROOT, file);
  const realRequire = createRequire(filename);
  const ctx = { module: { exports: {} }, console, process: { env: {} }, require: name => Object.hasOwn(deps, name) ? deps[name] : realRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  return ctx.module.exports;
}
function fixture() {
  return { id: 42, name: 'Promo', goal: 'increase_average_sale', status: 'active', start_date: '04/09/2026', end_date: null, owner_location_id: 10, locations: [{ id: 10 }], promo_rule: { id: 43, order_types: [], maximum_qty_applied_to_products: [], use_promotion_code: true, promotion_code_maximum_usage: '10' }, promo_reward: { id: 44, get_products: null, discount_in_house_cost: 100 } };
}
function harness() {
  const h = { remote: fixture(), codes: [{ id: 45, code: 'ABC', number_of_usage: '2', maximum_usage: '10', usage_type: 'multiple', last_usage: null }], state: { promo: null, rule: null, reward: null, codes: [] }, creates: 0, generations: [], transactions: 0, batches: 0, locationQueries: 0, missingLocation: false, failCodes: false, failWrite: false };
  const prisma = {
    promo: { findUnique: async () => h.state.promo && { ...h.state.promo, promoRule: h.state.rule, promoReward: h.state.reward, PromoCode: h.state.codes }, findMany: () => Promise.resolve(h.state.promo ? [{ ...h.state.promo, promoRule: h.state.rule, promoReward: h.state.reward }] : []), count: () => Promise.resolve(h.state.promo ? 1 : 0) },
    location: { findMany: async () => { h.locationQueries++; return h.missingLocation ? [] : [{ runchise_id: 10, location_id: ID }]; } },
    $transaction: async fn => {
      if (Array.isArray(fn)) return Promise.all(fn);
      h.transactions++;
      const draft = structuredClone(h.state);
      const updateDefined = (target, values) => Object.assign(target, Object.fromEntries(Object.entries(values).filter(([,v]) => v !== undefined)));
      const tx = {
        promo: { upsert: async ({ create, update }) => { draft.promo = updateDefined(draft.promo || { promo_id: ID }, draft.promo ? update : create); return draft.promo; }, update: async ({ data }) => { updateDefined(draft.promo, data); return draft.promo; } },
        promoRule: { upsert: async ({ create, update }) => draft.rule = updateDefined(draft.rule || {}, draft.rule ? update : create) },
        promoReward: { upsert: async ({ create, update }) => draft.reward = updateDefined(draft.reward || {}, draft.reward ? update : create) },
        promoCode: {
          findMany: async ({ where }) => where.runchise_id ? draft.codes.filter(c => where.runchise_id.in.includes(c.runchise_id)) : draft.codes.filter(c => c.promo_id === where.promo_id),
          createMany: async ({ data }) => { h.batches++; if (h.failWrite) throw Error('write failed'); draft.codes.push(...data); },
          update: async ({ where, data }) => { if (h.failWrite) throw Error('write failed'); const row = draft.codes.find(c => c.runchise_id === where.runchise_id && c.promo_id === where.promo_id); assert.ok(row); return updateDefined(row, data); },
        },
      };
      const result = await fn(tx);
      h.state = draft;
      return result;
    },
  };
  const api = {
    createPromo: async () => { h.creates++; return h.remote; },
    getPromo: async () => h.remote,
    generatePromoCode: async input => {
      h.generations.push(input);
      if (h.failGenerate) throw Object.assign(Error('generate failed'), { statusCode: 502 });
      h.codes.push({ id: 46, code: 'GENERATED', maximum_usage: 1, number_of_usage: 0 });
    },
    updatePromo: async () => ({ id: 42 }),
    activatePromo: async () => { h.remote.status = 'active'; return true; },
    deactivatePromo: async () => { h.remote.status = 'inactive'; return true; },
    getListPromoCodes: async () => { if (h.failCodes) throw Error('codes unavailable'); return h.codes; },
  };
  h.service = load('src/services/promo.service.js', { '../lib/prisma': prisma, './runchise.service': api });
  h.controller = load('src/controllers/promo.controller.js', { '../services/promo.service': h.service });
  return h;
}
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample_promo.json')))[0];

test('create normalizes dates/numbers/null arrays and shares detail response format', async () => {
  const h = harness();
  const result = await h.service.createPromoService(payload);
  assert.equal(result.promo.start_date.toISOString(), '2026-09-04T00:00:00.000Z');
  assert.equal(result.promo.end_date, null);
  assert.equal(result.promo_rule.promotion_code_maximum_usage, 10);
  assert.equal(result.promo_reward.discount_in_house_cost, '100');
  assert.equal(result.promo_reward.get_products.length, 0);
  assert.equal(result.promo_codes[0].number_of_usage, 2);
  assert.equal(h.transactions, 1);
  assert.equal(h.locationQueries, 1);
  assert.equal(JSON.stringify(await h.service.showPromoService(ID)), JSON.stringify(result));
  const list = await h.service.listPromoService({ page: '1' });
  assert.equal(list.data[0].promo.promo_id, ID);
  assert.equal(list.data[0].promo_codes, undefined);
});

test('fetch failure writes nothing; sync recovery never repeats external create', async () => {
  const h = harness(); h.failCodes = true;
  await assert.rejects(h.service.createPromoService(payload), error => error.code === 'PROMO_SYNC_FAILED' && error.runchise_id === 42 && error.cause.message === 'codes unavailable');
  assert.equal(h.state.promo, null); assert.equal(h.transactions, 0);
  h.failCodes = false;
  await h.service.syncPromoService('42'); await h.service.syncPromoService('42');
  assert.equal(h.creates, 1); assert.equal(h.state.codes.length, 1);
});

test('code write failure rolls back promo/rule/reward together', async () => {
  const h = harness(); h.failWrite = true;
  await assert.rejects(h.service.syncPromoService(42), { code: 'PROMO_SYNC_FAILED' });
  assert.deepEqual(h.state, { promo: null, rule: null, reward: null, codes: [] });
});

test('update refreshes existing code counters, limits, type and dates', async () => {
  const h = harness(); await h.service.syncPromoService(42);
  h.codes[0] = { ...h.codes[0], number_of_usage: '5', maximum_usage: 20, usage_type: 'single', last_usage: '2026-09-07T10:00:00+07:00' };
  const result = await h.service.updatePromoService(ID, { name: 'Updated' });
  assert.equal(result.promo_codes[0].number_of_usage, 5);
  assert.equal(result.promo_codes[0].maximum_usage, 20);
  assert.equal(result.promo_codes[0].usage_type, 'single');
  assert.equal(result.promo_codes[0].last_usage.toISOString(), '2026-09-07T03:00:00.000Z');
});

test('activate and deactivate persist authoritative remote status', async () => {
  const h = harness(); await h.service.syncPromoService(42);
  await h.service.deactivatePromoService(ID); assert.equal(h.state.promo.status, 'inactive');
  await h.service.activatePromoService(ID); assert.equal(h.state.promo.status, 'active');
});

test('missing location, incomplete response and invalid dates fail before any transaction', async () => {
  for (const change of [h => h.missingLocation = true, h => delete h.remote.locations, h => delete h.remote.promo_reward.get_products, h => h.remote.start_date = '31/02/2026', h => h.remote.promo_reward.discount_in_house_cost = 'abc', h => h.remote.id = 100]) {
    const h = harness(); change(h);
    await assert.rejects(h.service.syncPromoService(42), { code: 'PROMO_SYNC_FAILED' });
    assert.equal(h.transactions, 0);
  }
});

test('new codes use batches of at most 100 and reject cross-promo ownership', async () => {
  const h = harness(); h.codes = Array.from({ length: 205 }, (_, i) => ({ id: i + 100, code: `CODE${i}` }));
  await h.service.syncPromoService(42);
  assert.equal(h.batches, 3); assert.equal(h.state.codes.length, 205);
  h.state.codes[0].promo_id = 'another-promo';
  await assert.rejects(h.service.syncPromoService(42), { code: 'PROMO_SYNC_FAILED' });
});

test('invalid input and missing promo return typed errors', async () => {
  const h = harness();
  await assert.rejects(h.service.showPromoService('bad'), { name: 'ZodError' });
  await assert.rejects(h.service.showPromoService(ID), { code: 'PROMO_NOT_FOUND', statusCode: 404 });
  await assert.rejects(h.service.updatePromoService(ID, {}), { code: 'EMPTY_UPDATE' });
  await assert.rejects(h.service.listPromoService({ page: '2147483647', limit: '100' }), { code: 'INVALID_PAGINATION' });
});

test('controller exposes recoverable remote ID and includes activation data', async () => {
  const h = harness();
  const res = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  h.failCodes = true; let response = res();
  await h.controller.createPromoController({ body: payload }, response);
  assert.equal(response.code, 502); assert.equal(response.body.message.runchise_id, 42);
  h.failCodes = false; await h.service.syncPromoService(42); response = res();
  await h.controller.activatePromoController({ params: { promo_id: ID } }, response);
  assert.equal(response.code, 200); assert.equal(response.body.data.promo.status, 'active');
  response = res(); await h.controller.syncPromoController({ params: { runchise_id: 'bad' } }, response);
  assert.equal(response.code, 422);
});

test('generator uses code count, avoids duplicate candidates, and validates bounds', async () => {
  let posted, calls = 0, generated = 0;
  const api = load('src/services/runchise.service.js', {
    '../lib/prisma': {}, dotenv: { config() {} },
    axios: { create: () => ({ post: async (url, data) => { calls++; posted = { url, data }; return { data: { ok: true } }; }, get: async url => ({ data: { promo: { id: 42 }, url } }) }), isAxiosError: () => false },
    '../utils/generateReferralCode': { generateRandomUniqueCode: () => ['AAA', 'AAA', 'BBB', 'CCC'][generated++] },
  });
  await api.generatePromoCode({ runchise_promo_id: 42, total_code: 3 });
  assert.equal(posted.data.promo_codes.length, 3);
  assert.equal(new Set(posted.data.promo_codes.map(c => c.code)).size, 3);
  for (const total_code of [0, -1, 1.5, 1001, Infinity]) await assert.rejects(api.generatePromoCode({ runchise_promo_id: 42, total_code }));
  assert.equal(calls, 1);
  assert.equal((await api.getPromo(42)).id, 42);
});

test('invalid input calendar/numeric values are rejected before remote create', async () => {
  const h = harness();
  await assert.rejects(h.service.createPromoService({ ...payload, start_date: '31/02/2026' }), { name: 'ZodError' });
  await assert.rejects(h.service.createPromoService({ ...payload, promo_reward_attributes: { ...payload.promo_reward_attributes, discount_amount: 'oops' } }), { name: 'ZodError' });
  assert.equal(h.creates, 0);
});

test('promos without promotion codes do not depend on the codes endpoint', async () => {
  const h = harness(); h.remote.promo_rule.use_promotion_code = false; h.failCodes = true;
  const result = await h.service.syncPromoService(42);
  assert.equal(result.promo_codes.length, 0);
});

test('sync and existing routes keep authenticated admin/marketing access', () => {
  const h = harness(), routes = [], auth = () => {}, role = () => {};
  load('src/routes/promo.routes.js', {
    express: { Router: () => Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (...args) => routes.push([method, ...args])])) },
    '../middleware/authMiddleware': { auth, requireRole: (...roles) => { assert.deepEqual(roles, ['admin', 'marketing']); return role; } },
    '../controllers/promo.controller': h.controller,
  });
  assert.equal(routes.length, 8);
  assert.deepEqual(routes.find(r => r[1] === '/:promo_id/promo-codes/generate'), ['post', '/:promo_id/promo-codes/generate', auth, role, h.controller.generatePromoCodeController]);
  assert.deepEqual(routes.find(r => r[1] === '/sync/:runchise_id'), ['post', '/sync/:runchise_id', auth, role, h.controller.syncPromoController]);
  for (const route of routes) { assert.equal(route[2], auth); assert.equal(route[3], role); assert.equal(typeof route[4], 'function'); }
});

test('generate endpoint maps local UUID, generates once, and saves codes', async () => {
  const h = harness();
  await h.service.createPromoService(payload);
  await h.service.updatePromoService(ID, { name: 'Changed' });
  assert.equal(h.generations.length, 0);
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await h.controller.generatePromoCodeController({ params: { promo_id: ID }, body: { total_code: 1 } }, res);
  assert.equal(res.code, 201);
  assert.equal(h.generations.length, 1);
  assert.equal(h.generations[0].runchise_promo_id, 42);
  assert.equal(h.generations[0].total_code, 1);
  assert.ok(res.body.data.promo_codes.some(code => code.code === 'GENERATED'));
});

test('invalid generation requests and disabled/missing promos do not generate', async () => {
  const h = harness();
  for (const body of [undefined, {}, { total_code: 0 }, { total_code: 1001 }, { total_code: 1.5 }, { total_code: '10' }, { total_code: 1, runchise_promo_id: 99 }]) {
    await assert.rejects(h.service.generatePromoCodeService(ID, body), { name: 'ZodError' });
  }
  await assert.rejects(h.service.generatePromoCodeService('bad', { total_code: 1 }), { name: 'ZodError' });
  await assert.rejects(h.service.generatePromoCodeService(ID, { total_code: 1 }), { code: 'PROMO_NOT_FOUND' });
  await h.service.syncPromoService(42);
  h.state.rule.use_promotion_code = false;
  await assert.rejects(h.service.generatePromoCodeService(ID, { total_code: 1 }), { code: 'PROMO_CODES_DISABLED', statusCode: 409 });
  assert.equal(h.generations.length, 0);
});

test('generation failure does not sync; sync recovery never generates again', async () => {
  const h = harness(); await h.service.syncPromoService(42);
  h.failGenerate = true;
  const transactions = h.transactions;
  await assert.rejects(h.service.generatePromoCodeService(ID, { total_code: 1 }), /generate failed/);
  assert.equal(h.transactions, transactions);
  h.failGenerate = false; h.failCodes = true;
  await assert.rejects(h.service.generatePromoCodeService(ID, { total_code: 1 }), error => error.code === 'PROMO_SYNC_FAILED' && error.runchise_id === 42);
  const generations = h.generations.length;
  h.failCodes = false;
  await h.service.syncPromoService(42);
  assert.equal(h.generations.length, generations);
  assert.ok(h.state.codes.some(code => code.code === 'GENERATED'));
});
