require('dotenv').config();

const prisma = require('../src/lib/prisma');
const {
  syncRunchisePosRewardRedemptions,
} = require('../src/services/runchisePosRewardRedemptionService');

async function main() {
  const [locationId, startDate, endDateExclusive] = process.argv.slice(2);
  const result = await syncRunchisePosRewardRedemptions({
    locationId: locationId ? Number(locationId) : undefined,
    startDate,
    endDate: endDateExclusive,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(`Sinkronisasi reward POS gagal: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
