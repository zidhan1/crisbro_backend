const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../src/lib/prisma');
const { syncPromos } = require('../src/services/syncService');

async function main() {
  if (!process.env.RUNCHISE_API_KEY) {
    throw new Error('RUNCHISE_API_KEY tidak tersedia');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL tidak tersedia');
  }

  console.log('Memulai import seluruh promo Runchise...');
  const result = await syncPromos();
  console.log('\n=== HASIL IMPORT PROMO ===');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        `\nImport promo gagal: ${error.response?.data?.message || error.message}`,
      );
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { main };
