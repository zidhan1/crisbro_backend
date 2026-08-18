// Session-level advisory locks hanya aman bila seluruh umur lock memakai satu
// backend PostgreSQL fisik. Transaction pooler pada DATABASE_URL tidak memberi
// jaminan itu, maka deployment wajib memakai koneksi direct/session-safe.
function getAdvisoryLockConnectionString(env = process.env) {
  const directUrl = String(env.DIRECT_URL || '').trim();
  if (directUrl) return directUrl;

  // Jangan pernah menebak bahwa DATABASE_URL aman. Konfigurasi development,
  // preview, dan test juga dapat menunjuk transaction pooler; fallback akan
  // membuat bug eksklusivitas muncul kembali tanpa tanda apa pun.
  const error = new Error(
    'DIRECT_URL wajib diisi dengan koneksi PostgreSQL direct/session-mode untuk advisory lock',
  );
  error.code = 'DIRECT_URL_REQUIRED_FOR_ADVISORY_LOCK';
  throw error;
}

function createAdvisoryLockClient() {
  // Resolve saat invocation agar test/dependency injection tidak terikat pada
  // constructor yang tercache ketika modul pertama kali dimuat.
  const { Client } = require('pg');
  return new Client({
    connectionString: getAdvisoryLockConnectionString(),
    application_name: 'crisbro-advisory-lock',
  });
}

module.exports = {
  createAdvisoryLockClient,
  getAdvisoryLockConnectionString,
};
