const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const { upsertRunchiseCustomer } = require('../src/services/syncService');

test('P2002 saat create direkonsiliasi ke customer pemenang tanpa duplikasi', async (t) => {
  const original = {
    brandUpsert: prisma.brand.upsert,
    locationFindMany: prisma.location.findMany,
    customerFindFirst: prisma.customer.findFirst,
    userFindFirst: prisma.user.findFirst,
    userCreate: prisma.user.create,
    customerUpdate: prisma.customer.update,
    userUpdate: prisma.user.update,
    locationDeleteMany: prisma.customerLocation.deleteMany,
    locationCreateMany: prisma.customerLocation.createMany,
    transaction: prisma.$transaction,
  };
  t.after(() => {
    prisma.brand.upsert = original.brandUpsert;
    prisma.location.findMany = original.locationFindMany;
    prisma.customer.findFirst = original.customerFindFirst;
    prisma.user.findFirst = original.userFindFirst;
    prisma.user.create = original.userCreate;
    prisma.customer.update = original.customerUpdate;
    prisma.user.update = original.userUpdate;
    prisma.customerLocation.deleteMany = original.locationDeleteMany;
    prisma.customerLocation.createMany = original.locationCreateMany;
    prisma.$transaction = original.transaction;
  });

  const winner = {
    id: 501,
    user_id: 601,
    runchise_id: null,
    user: { id: 601, phone_number: '81230000000', role: 'customer' },
  };
  let customerLookupCount = 0;
  let createCalls = 0;
  let transactionCalls = 0;

  prisma.brand.upsert = async () => undefined;
  prisma.location.findMany = async () => [];
  prisma.customer.findFirst = async () => {
    customerLookupCount += 1;
    return customerLookupCount === 3 ? winner : null;
  };
  prisma.user.findFirst = async () => null;
  prisma.user.create = async () => {
    createCalls += 1;
    const error = new Error('unique constraint race');
    error.code = 'P2002';
    throw error;
  };
  prisma.customer.update = async () => winner;
  prisma.user.update = async () => undefined;
  prisma.customerLocation.deleteMany = async () => undefined;
  prisma.customerLocation.createMany = async () => undefined;
  prisma.$transaction = async (operations) => {
    transactionCalls += 1;
    assert.ok(Array.isArray(operations));
    return [];
  };

  const result = await upsertRunchiseCustomer({
    id: 7001,
    brand_id: 1,
    name: 'Race Customer',
    phone_number: '81230000000',
    location_ids: [],
    status: 'active',
  });

  assert.equal(createCalls, 1);
  assert.equal(transactionCalls, 1);
  assert.deepEqual(result, {
    status: 'updated_after_conflict',
    customer_id: 501,
    unresolved_location_ids: [],
  });
});
