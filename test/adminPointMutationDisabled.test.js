const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createAdminCustomer,
  updateAdminCustomer,
} = require('../src/controllers/adminLoyalty/adminCustomerController');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin tidak memiliki route atau controller adjustment poin manual', () => {
  const routes = read('src/routes/adminLoyaltyRoutes.js');
  const composition = read('src/controllers/adminLoyaltyController.js');
  const customerController = read('src/controllers/adminLoyalty/adminCustomerController.js');
  const validation = read('src/middleware/adminLoyaltyValidation.js');

  for (const source of [routes, composition, customerController, validation]) {
    assert.doesNotMatch(source, /loyalty-adjustment|adjustCustomerLoyalty|admin_adjustment/);
  }
});

test('endpoint create/update customer menolak field saldo dan poin secara eksplisit', () => {
  const source = read('src/controllers/adminLoyalty/adminCustomerController.js');
  assert.ok((source.match(/Saldo dan poin dikelola otomatis dan tidak dapat diubah admin/g) || []).length >= 2);
  assert.ok((source.match(/\['balance', 'total_point', 'available_point'\]/g) || []).length >= 2);
});

const createResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return response;
};

for (const field of ['balance', 'total_point', 'available_point']) {
  test(`create customer menolak field ${field} sebelum akses database`, async () => {
    const res = createResponse();
    await createAdminCustomer({ body: { [field]: 100 } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(
      res.body.message,
      'Saldo dan poin dikelola otomatis dan tidak dapat diubah admin',
    );
  });

  test(`update customer menolak field ${field} sebelum akses database`, async () => {
    const res = createResponse();
    await updateAdminCustomer({ params: { id: '1' }, body: { [field]: 100 } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(
      res.body.message,
      'Saldo dan poin dikelola otomatis dan tidak dapat diubah admin',
    );
  });
}
