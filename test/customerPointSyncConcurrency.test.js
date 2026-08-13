const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const syncSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'syncService.js'),
  'utf8',
);
const adminSource = fs.readFileSync(
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
const importerSource = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'importSelectedCustomers.js'),
  'utf8',
);

test('M-6: kedua jalur sync menyimpan snapshot Runchise dan menerapkan delta, bukan overwrite absolut', () => {
  assert.equal(
    (syncSource.match(/"runchise_total_point" = EXCLUDED\."runchise_total_point"/g) || [])
      .length,
    2,
  );
  assert.equal(
    (syncSource.match(/"CustomerPoint"\."available_point" \+/g) || []).length,
    2,
  );
  assert.doesNotMatch(
    syncSource,
    /"available_point"\s*=\s*EXCLUDED\."available_point"/,
  );
});

test('M-6: rumus rebase mempertahankan koreksi admin dan debit redemption', () => {
  const rebase = (effective, oldRunchise, newRunchise) =>
    effective + (newRunchise - (oldRunchise ?? newRunchise));

  // Snapshot 500, admin +100, redemption -150, lalu POS bertambah 25.
  assert.equal(rebase(450, 500, 525), 475);
  // Row lama dari sebelum migration tidak punya baseline: sync pertama aman.
  assert.equal(rebase(350, null, 900), 350);
});

test('M-6: jalur admin membuat row sebelum SELECT FOR UPDATE', () => {
  const insertAt = adminSource.indexOf('ON CONFLICT ("customer_id") DO NOTHING');
  const lockAt = adminSource.indexOf(
    'SELECT total_point, available_point FROM "CustomerPoint"',
  );
  assert.ok(insertAt >= 0);
  assert.ok(lockAt > insertAt);
});

test('M-6: importer customer yang rerunnable juga tidak meng-overwrite saldo efektif', () => {
  assert.match(importerSource, /"CustomerPoint"\."available_point" \+/);
  assert.doesNotMatch(importerSource, /customerPoint\.upsert/);
});
