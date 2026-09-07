const { z } = require("zod");

const generatePromoCodeSchema = z.object({
  total_code: z.number().int().min(1).max(1000),
}).strict();

module.exports = { generatePromoCodeSchema };
