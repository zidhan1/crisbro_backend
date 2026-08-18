const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const externalUrl = process.env.POSTGRES_TEST_URL;
// Prefer executables on PATH (GitHub's Postgres service and package-manager
// installs use this), while retaining the conventional Windows installer
// location for local runs that do not provide POSTGRES_TEST_URL.
const pgBin = process.env.POSTGRES_BIN ||
  (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : '');
const executables = {
  initdb: pgBin ? path.join(pgBin, process.platform === 'win32' ? 'initdb.exe' : 'initdb') : 'initdb',
  pgCtl: pgBin ? path.join(pgBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl') : 'pg_ctl',
  createdb: pgBin ? path.join(pgBin, process.platform === 'win32' ? 'createdb.exe' : 'createdb') : 'createdb',
  psql: pgBin ? path.join(pgBin, process.platform === 'win32' ? 'psql.exe' : 'psql') : 'psql',
};
if (!externalUrl) {
  for (const [name, executable] of Object.entries(executables)) {
    if (!fs.existsSync(executable)) throw new Error(`${name} tidak ditemukan: ${executable}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crisbro-pg-integration-'));
const data = path.join(root, 'data');
const log = path.join(root, 'postgres.log');
const port = 56000 + Math.floor(Math.random() * 3000);
const database = 'crisbro_integration_test';
const url = `postgresql://postgres@127.0.0.1:${port}/${database}`;
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} gagal (${result.status})`);
}

try {
  if (!externalUrl) {
    run(executables.initdb, ['-A', 'trust', '-U', 'postgres', '-D', data]);
    run(executables.pgCtl, ['-D', data, '-o', `-p ${port} -h 127.0.0.1`, '-l', log, 'start']);
    started = true;
    run(executables.createdb, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', database]);
  }
  const testUrl = externalUrl || url;
  // Supabase provides these roles. Create non-login stand-ins so its
  // grant/revoke migrations can also be replayed on disposable PostgreSQL.
  if (!externalUrl) {
    run(executables.psql, [
      '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database,
      '-v', 'ON_ERROR_STOP=1',
      '-c', 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;',
    ]);
  }
  if (externalUrl) {
    run(process.execPath, ['-e', `
      const { Client } = require('pg');
      (async () => {
        const client = new Client({ connectionString: process.env.POSTGRES_TEST_URL });
        await client.connect();
        for (const role of ['anon', 'authenticated', 'service_role']) {
          const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
          if (!exists.rowCount) await client.query('CREATE ROLE ' + role + ' NOLOGIN');
        }
        await client.end();
      })().catch((error) => { console.error(error); process.exit(1); });
    `], { env: process.env });
  }
  const env = {
    ...process.env,
    LOAD_TEST_DATABASE_URL: testUrl,
    DATABASE_URL: testUrl,
    DIRECT_URL: testUrl,
  };
  // Run the real migration chain so integration tests exercise database-only
  // guarantees (CHECK constraints, repair SQL), not merely the Prisma model.
  run(process.execPath, [
    path.join('node_modules', 'prisma', 'build', 'index.js'),
    'migrate', 'deploy', '--config', 'prisma.load-test.config.ts',
  ], { env });
  run(process.execPath, ['--test', '--test-concurrency=1', 'test-integration/*.test.js'], { env });
} finally {
  if (started) {
    spawnSync(executables.pgCtl, ['-D', data, 'stop', '-m', 'fast'], { stdio: 'inherit' });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
