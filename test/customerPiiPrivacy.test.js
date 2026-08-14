const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildReportSearchFilter,
  redactReportForRole,
} = require('../src/controllers/adminLoyalty/salesTransactionReportController');

test('H-4: marketing tidak menerima nama, telepon, atau raw report', () => {
  const output = redactReportForRole({
    id: 1,
    nama_pelanggan: 'Nama Rahasia',
    no_telepon: '081234567890',
    raw: { customer: { phone: '081234567890' } },
    nama_outlet: 'Outlet A',
  }, 'marketing');

  assert.equal(output.nama_pelanggan, null);
  assert.equal(output.no_telepon, null);
  assert.equal(Object.hasOwn(output, 'raw'), false);
  assert.equal(JSON.stringify(output).includes('081234567890'), false);
  assert.equal(output.nama_outlet, 'Outlet A');
});

test('H-4: admin tetap menerima PII laporan untuk kebutuhan operasional', () => {
  const report = {
    nama_pelanggan: 'Budi',
    no_telepon: '0812',
    raw: { source: true },
  };
  assert.deepEqual(redactReportForRole(report, 'admin'), report);
});

test('H-4: pencarian marketing tidak membangun filter nama atau telepon', () => {
  const filter = buildReportSearchFilter('081234', { includePii: false });
  const serialized = JSON.stringify(filter);
  assert.equal(serialized.includes('nama_pelanggan'), false);
  assert.equal(serialized.includes('no_telepon'), false);
  assert.equal(serialized.includes('nama_outlet'), true);
  assert.equal(serialized.includes('tipe_order'), true);
});

test('H-4: pencarian admin tetap dapat memakai nama dan telepon', () => {
  const serialized = JSON.stringify(
    buildReportSearchFilter('081234', { includePii: true }),
  );
  assert.equal(serialized.includes('nama_pelanggan'), true);
  assert.equal(serialized.includes('no_telepon'), true);
});

test('M-7: route delete customer hanya memakai adminOnly', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'adminLoyaltyRoutes.js'),
    'utf8',
  );
  assert.match(
    source,
    /router\.delete\('\/customers\/:id', adminOnly, validateIdParam, deleteAdminCustomer\)/,
  );
  assert.doesNotMatch(
    source,
    /router\.delete\('\/customers\/:id', adminOrMarketing/,
  );
});

test('M-7: migration membersihkan seluruh PII snapshot yang sudah yatim', () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '20260814160000_anonymize_orphan_customer_pii',
      'migration.sql',
    ),
    'utf8',
  );
  for (const field of [
    'nama_pelanggan',
    'no_telepon',
    'customer_name',
    'customer_phone_number',
    'raw',
  ]) {
    assert.match(migration, new RegExp(`"${field}" = NULL`));
  }
  assert.match(migration, /WHERE "customer_id" IS NULL/g);
  assert.match(migration, /UPDATE "AdminActivityLog"/);
  assert.match(migration, /WHERE "action" = 'delete_customer'/);
});

test('M-7: delete tidak menyalin snapshot customer lengkap ke audit log', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'src',
      'controllers',
      'adminLoyalty',
      'adminCustomerController.js',
    ),
    'utf8',
  );
  const deleteBody = source.match(
    /async function deleteAdminCustomer[\s\S]+?async function listAdminBrands/,
  )?.[0] ?? '';
  assert.match(deleteBody, /before: \{ id \}/);
  assert.doesNotMatch(deleteBody, /getCustomerAuditSnapshot/);
  assert.match(deleteBody, /customerSalesTransactionReport\.updateMany/);
  assert.match(deleteBody, /runchisePosRewardRedemption\.updateMany/);
  assert.match(deleteBody, /raw: Prisma\.DbNull/g);
});
