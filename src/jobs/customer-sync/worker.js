require("dotenv").config({ quiet: true });

const { Worker } = require("bullmq");
const { registerCustomerSyncScheduler } = require("./scheduler");
const { connection } = require("../../lib/redis");
const prisma = require("../../lib/prisma");
const {
  getListSaleTransactionSummary,
  findCustomerByPhone,
  getPromo,
  getListPromoCodes,
} = require("../../services/runchise.service");

const worker = new Worker(
  "customer-sync",
  async (job) => {
    // 1. Ambil checkpoint terakhir
    const checkpoint = await prisma.syncCheckpoints.findFirst({
      where: { job_category: "sale_transactions" },
    });

    const last_sync_id = checkpoint ? checkpoint.last_sync_id : null;

    // 2. Ambil transaksi baru dari runchise
    const transactions = await getListSaleTransactionSummary(last_sync_id);

    if (transactions.length === 0) return { processed: 0 };

    // 3. Customer Sync
    await customerProcessHandler(transactions);

    // 4. Promo Sync
    const transactionsWithPromo = transactions.filter(
      (t) => t.applied_promos && t.applied_promos.length > 0,
    );

    const promoIds = transactionsWithPromo.flatMap((t) =>
      t.applied_promos.map((p) => p.id),
    );

    const promos = await prisma.promo.findMany({
      where: { runchise_id: { in: promoIds } },
    });

    const { default: pLimit } = await import("p-limit");
    const limit = pLimit(5); // maksimal 5 request paralel ke API eksternal

    await Promise.all(
      promos.map((promo) =>
        limit(async () => {
          try {
            const data = await getPromo(promo.runchise_id);

            await prisma.promo.update({
              where: { promo_id: promo.promo_id },
              data: {
                status: data.status,
              },
            });

            // Update Promo Codes
            const promoCodes = await getListPromoCodes(promo.runchise_id);

            for (const promoCode of promoCodes) {
              try {
                await prisma.promoCode.update({
                  where: { runchise_id: promoCode.id },
                  data: {
                    status: promoCode.status,
                    last_usage: new Date(promoCode.last_usage),
                    deactivate_at: new Date(promoCode.deactivate_at),
                    deactivate_reason: promoCode.deactivate_reason,
                  },
                });
              } catch (error) {
                console.error(
                  `Gagal update sync promo code ${promoCode.id}, error: ${error.message}`,
                );
              }
            }
          } catch (error) {
            console.error(
              `Gagal sync update promo ${promo.promo_id}:`,
              error.message,
            );
          }
        }),
      ),
    );

    // 5. Save Checkpoint
    await saveCheckpointHandler(transactions[transactions.length - 1].id);

    return { processed: transactions.length };
  },
  {
    connection,
    concurrency: 1,
  },
);

worker.on("error", (error) => {
  console.error("Customer sync worker error:", error);
});

worker.on("failed", (job, error) => {
  console.error(`Customer sync job ${job?.id} gagal:`, error);
});

registerCustomerSyncScheduler()
  .then(() => {
    console.log("Customer sync scheduler aktif setiap 5 menit.");
  })
  .catch((error) => {
    console.error("Gagal mendaftarkan customer sync scheduler:", error);
    process.exit(1);
  });
