const { Queue } = require("bullmq");
const { connection } = require("./redis");

const syncQueue = new Queue("customer-sync", { connection });

module.exports = { syncQueue };
