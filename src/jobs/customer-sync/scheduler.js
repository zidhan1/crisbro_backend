const { syncQueue } = require("../../lib/queue");

async function registerCustomerSyncScheduler() {
  return syncQueue.upsertJobScheduler(
    "customer-sync-every-minute",
    { every: 5 * 60_000 },
    {
      name: "customer-sync",
      data: {},
      opts: {
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    },
  );
}

module.exports = { registerCustomerSyncScheduler };
