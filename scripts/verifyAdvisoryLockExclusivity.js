require('dotenv').config({ quiet: true });

const { Client } = require('pg');
const {
  getAdvisoryLockConnectionString,
} = require('../src/lib/advisoryLockClient');

const LOCK_NAMESPACE = 1_384_405_203;
const VERIFICATION_LOCK_ID = 2_147_483_000;

async function unlock(client) {
  if (!client) return;
  await client
    .query('SELECT pg_advisory_unlock($1, $2)', [
      LOCK_NAMESPACE,
      VERIFICATION_LOCK_ID,
    ])
    .catch(() => {});
}

async function main() {
  // Verifikasi ini sengaja tidak fallback ke DATABASE_URL: target test harus
  // koneksi yang benar-benar akan dipakai advisory lock di deployment.
  const directUrl = String(process.env.DIRECT_URL || '').trim();
  if (!directUrl) {
    throw new Error('DIRECT_URL wajib diisi untuk verifikasi eksklusivitas lock');
  }
  const connectionString = getAdvisoryLockConnectionString({
    DIRECT_URL: directUrl,
    VERCEL: '1',
  });
  const first = new Client({ connectionString, application_name: 'crisbro-lock-check-1' });
  const second = new Client({ connectionString, application_name: 'crisbro-lock-check-2' });

  try {
    await Promise.all([first.connect(), second.connect()]);
    const [firstPid, secondPid] = await Promise.all([
      first.query('SELECT pg_backend_pid() AS pid'),
      second.query('SELECT pg_backend_pid() AS pid'),
    ]);
    if (firstPid.rows[0]?.pid === secondPid.rows[0]?.pid) {
      throw new Error('Dua client tidak memperoleh session PostgreSQL terpisah');
    }

    const acquiredFirst = await first.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [LOCK_NAMESPACE, VERIFICATION_LOCK_ID],
    );
    if (acquiredFirst.rows[0]?.acquired !== true) {
      throw new Error('Koneksi pertama tidak dapat memperoleh verification lock');
    }

    const blockedSecond = await second.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [LOCK_NAMESPACE, VERIFICATION_LOCK_ID],
    );
    if (blockedSecond.rows[0]?.acquired !== false) {
      throw new Error('FAIL: koneksi kedua memperoleh lock yang sedang dipegang');
    }

    await unlock(first);
    const acquiredAfterRelease = await second.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [LOCK_NAMESPACE, VERIFICATION_LOCK_ID],
    );
    if (acquiredAfterRelease.rows[0]?.acquired !== true) {
      throw new Error('Lock tidak dapat diperoleh setelah koneksi pertama melepasnya');
    }

    console.log(JSON.stringify({
      status: 'passed',
      separate_backend_sessions: true,
      second_blocked_while_first_held_lock: true,
      second_acquired_after_release: true,
    }));
  } finally {
    await Promise.all([unlock(first), unlock(second)]);
    await Promise.all([first.end().catch(() => {}), second.end().catch(() => {})]);
  }
}

main().catch((error) => {
  console.error(`Advisory lock verification failed: ${error.message}`);
  process.exitCode = 1;
});
