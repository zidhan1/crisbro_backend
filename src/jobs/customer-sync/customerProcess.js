const prisma = require("../../lib/prisma");
const { findCustomerByPhone } = require("../../services/runchise.service");

async function customerProcessHandler(transactions) {
  const phones = [
    ...new Set(
      transactions
        .map((t) => t.customer_phone_number)
        .filter((f) => f !== null),
    ),
  ];

  // 3. Cari customer yang match di runchise
  const customers = await prisma.customer.findMany({
    where: { phone_number: { in: phones } },
  });

  // 4. Cari customer yang datanya berubah di runchise
  let updated = 0;
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(5); // maksimal 5 request paralel ke API eksternal

  await Promise.all(
    customers.map((customer) =>
      limit(async () => {
        try {
          const data = await findCustomerByPhone({
            phone: customer.phone_number,
          });

          await prisma.customer.update({
            where: { customer_id: customer.customer_id },
            data: {
              available_point: data.available_point,
              total_point: data.total_point,
              runchise_synced_at: new Date(),
            },
          });

          updated++;
        } catch (error) {
          console.error(
            `Gagal sync update customer ${customer.customer_id}:`,
            error.message,
          );
        }
      }),
    ),
  );

  return updated;
}

module.exports = { customerProcessHandler };
