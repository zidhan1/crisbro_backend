// Session-level advisory locks hanya aman bila seluruh umur lock memakai satu
// backend PostgreSQL fisik. Transaction pooler pada DATABASE_URL tidak memberi
// jaminan itu, maka deployment wajib memakai koneksi direct/session-safe.
function getAdvisoryLockConnectionString(env = process.env) {
  const directUrl = String(env.DIRECT_URL || '').trim();
  if (directUrl) return directUrl;

  if (env.VERCEL === '1' || env.NODE_ENV === 'production') {
    const error = new Error(
      'DIRECT_URL wajib diisi untuk session-level PostgreSQL advisory lock pada deployment',
    );
    error.code = 'DIRECT_URL_REQUIRED_FOR_ADVISORY_LOCK';
    throw error;
  }

  // Fallback hanya untuk local development/test yang biasanya terhubung
  // langsung ke PostgreSQL. Deployment tidak pernah melewati jalur ini.
  return env.DATABASE_URL;
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
