require('dotenv').config();

const prisma = require('../src/lib/prisma');
const { getSummary } = require('../src/controllers/adminLoyaltyController');

async function main() {
  let statusCode = 200;
  let responseBody;
  await getSummary(
    { query: { redemption_from: '2026-07-01', redemption_to: '2026-07-31' } },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return body;
      },
    },
  );

  if (statusCode !== 200) {
    throw new Error(`Dashboard mengembalikan HTTP ${statusCode}: ${JSON.stringify(responseBody)}`);
  }
  console.log(JSON.stringify({
    redemption_count: responseBody.redemption_count,
    top_rewards: responseBody.top_rewards,
    top_redeem_outlets: responseBody.top_redeem_outlets,
    redemption_history_count: responseBody.redemption_history.length,
    first_redemption: responseBody.redemption_history[0] ?? null,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
