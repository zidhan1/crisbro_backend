require('dotenv').config();

const prisma = require('../src/lib/prisma');
const {
  getSummary,
  listCustomerSalesTransactionReports,
} = require('../src/controllers/adminLoyaltyController');

async function invokeController(controller, query) {
  let statusCode = 200;
  let responseBody;
  await controller(
    { query },
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
    throw new Error(`Controller mengembalikan HTTP ${statusCode}: ${JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

async function main() {
  const responseBody = await invokeController(getSummary, {
    redemption_from: '2026-07-01',
    redemption_to: '2026-07-31',
  });
  const transactionReport = await invokeController(
    listCustomerSalesTransactionReports,
    {
      search: 'Windi',
      from: '2026-07-01',
      to: '2026-07-31',
      page: '1',
      limit: '100',
    },
  );
  const validatedTransaction = transactionReport.items.find(
    (item) => item.runchise_sales_transaction_id === 162656087,
  );
  console.log(JSON.stringify({
    redemption_count: responseBody.redemption_count,
    top_rewards: responseBody.top_rewards,
    top_redeem_outlets: responseBody.top_redeem_outlets,
    redemption_history_count: responseBody.redemption_history.length,
    first_redemption: responseBody.redemption_history[0] ?? null,
    transaction_report_rewards: validatedTransaction?.redeemed_rewards ?? [],
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
