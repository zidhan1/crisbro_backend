const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pgBin = process.env.POSTGRES_BIN || 'C:\\Program Files\\PostgreSQL\\17\\bin';
const executables = {
  initdb: path.join(pgBin, process.platform === 'win32' ? 'initdb.exe' : 'initdb'),
  pgCtl: path.join(pgBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
  createdb: path.join(pgBin, process.platform === 'win32' ? 'createdb.exe' : 'createdb'),
  psql: path.join(pgBin, process.platform === 'win32' ? 'psql.exe' : 'psql'),
};
for (const [name, executable] of Object.entries(executables)) {
  if (!fs.existsSync(executable)) throw new Error(`${name} tidak ditemukan: ${executable}`);
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
  run(executables.initdb, ['-A', 'trust', '-U', 'postgres', '-D', data]);
  run(executables.pgCtl, ['-D', data, '-o', `-p ${port} -h 127.0.0.1`, '-l', log, 'start']);
  started = true;
  run(executables.createdb, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', database]);
  // Supabase provides these roles. Create non-login stand-ins so its
  // grant/revoke migrations can also be replayed on disposable PostgreSQL.
  run(executables.psql, [
    '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database,
    '-v', 'ON_ERROR_STOP=1',
    '-c', 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;',
  ]);
  const env = {
    ...process.env,
    LOAD_TEST_DATABASE_URL: url,
    DATABASE_URL: url,
    DIRECT_URL: url,
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
