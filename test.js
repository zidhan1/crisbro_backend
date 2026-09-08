const prisma = require("./src/lib/prisma");
const {
  getListSaleTransactionSummary,
  findCustomerByPhone,
} = require("./src/services/runchise.service");

async function testCheckpoint() {
  const transactions = await findCustomerByPhone({ phone: "81259783014" });

  console.log(transactions);

  return transactions;
}

testCheckpoint();
