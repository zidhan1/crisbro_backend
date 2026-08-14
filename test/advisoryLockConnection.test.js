const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getAdvisoryLockConnectionString,
} = require('../src/lib/advisoryLockClient');

test('M-3: advisory lock selalu memilih DIRECT_URL ketika tersedia', () => {
  assert.equal(
    getAdvisoryLockConnectionString({
      DATABASE_URL: 'postgresql://pooler/db',
      DIRECT_URL: 'postgresql://direct/db',
      VERCEL: '1',
    }),
    'postgresql://direct/db',
  );
});

test('M-3: deployment gagal jelas bila DIRECT_URL hilang', () => {
  assert.throws(
    () => getAdvisoryLockConnectionString({
      DATABASE_URL: 'postgresql://pooler/db',
      VERCEL: '1',
    }),
    (error) => {
      assert.equal(error.code, 'DIRECT_URL_REQUIRED_FOR_ADVISORY_LOCK');
      assert.match(error.message, /DIRECT_URL wajib/);
      return true;
    },
  );
});

test('M-3: local development tetap boleh memakai DATABASE_URL langsung', () => {
  assert.equal(
    getAdvisoryLockConnectionString({ DATABASE_URL: 'postgresql://localhost/db' }),
    'postgresql://localhost/db',
  );
});

test('M-3: semua pemilik session advisory lock memakai factory session-safe', () => {
  const files = [
    'src/lib/distributedCronLock.js',
    'src/services/catalogSyncJobService.js',
    'src/services/customerImportSyncService.js',
    'src/services/customerTimestampSyncService.js',
    'src/services/salesTransactionSyncService.js',
  ];

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.match(
      source,
      /createAdvisoryLockClient/,
      `${relativePath} harus memakai koneksi advisory lock session-safe`,
    );
  }
});
