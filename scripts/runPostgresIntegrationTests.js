const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pgBin = process.env.POSTGRES_BIN || 'C:\\Program Files\\PostgreSQL\\17\\bin';
const executables = {
  initdb: path.join(pgBin, process.platform === 'win32' ? 'initdb.exe' : 'initdb'),
  pgCtl: path.join(pgBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
  createdb: path.join(pgBin, process.platform === 'win32' ? 'createdb.exe' : 'createdb'),
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
  const env = {
    ...process.env,
    LOAD_TEST_DATABASE_URL: url,
    DATABASE_URL: url,
    DIRECT_URL: url,
  };
  run(process.execPath, [
    path.join('node_modules', 'prisma', 'build', 'index.js'),
    'db', 'push', '--config', 'prisma.load-test.config.ts', '--skip-generate',
  ], { env });
  run(process.execPath, ['--test', '--test-concurrency=1', 'test-integration/*.test.js'], { env });
} finally {
  if (started) {
    spawnSync(executables.pgCtl, ['-D', data, 'stop', '-m', 'fast'], { stdio: 'inherit' });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
