const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const prismaClientDir = path.join(projectRoot, 'node_modules', '.prisma', 'client');
const windowsEngineFile = 'query_engine-windows.dll.node';
const windowsEnginePattern = /^query_engine-windows\.dll\.node\.tmp/;

function removeWindowsPrismaEngineFiles() {
  if (process.platform !== 'win32' || !fs.existsSync(prismaClientDir)) {
    return;
  }

  for (const entry of fs.readdirSync(prismaClientDir)) {
    if (entry !== windowsEngineFile && !windowsEnginePattern.test(entry)) {
      continue;
    }

    const filePath = path.join(prismaClientDir, entry);

    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      throw new Error(
        `Gagal menghapus file engine Prisma sebelum generate: ${filePath}. ` +
          `Tutup proses node/dev server yang memakai Prisma lalu jalankan build ulang. ` +
          `Detail: ${error.message}`,
      );
    }
  }
}

function runPrismaGenerate() {
  const prismaBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
  );
  const command = fs.existsSync(prismaBin) ? prismaBin : 'npx';
  const args = fs.existsSync(prismaBin)
    ? ['generate']
    : ['prisma', 'generate'];

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
  removeWindowsPrismaEngineFiles();
  runPrismaGenerate();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
