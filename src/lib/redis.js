const Redis = require("ioredis");

const options = {
  maxRetriesPerRequest: null, // wajib null untuk BullMQ
};

const connection = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, options)
  : new Redis({
      ...options,
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    });

module.exports = { connection };
