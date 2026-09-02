const { z } = require("zod");

const generateSaleTransactionSchema = z.object({
  customer_id: z.string().uuid("customer_id must be a valid UUID"),
});

module.exports = { generateSaleTransactionSchema };
