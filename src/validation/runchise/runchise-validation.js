const { z } = require("zod");

const createCustomerSchema = z.object({
  name: z.string().optional(),
  phone_number: z.string().min(11),
  address: z.string().optional(),
  phone_number_country_code: z.number().default(62),
  city: z.string().optional(),
  gender: z.string().optional(),
  email: z.string().email("Format email tidak valid"),
  province: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  owner_location_id: z.number(),
  brand_id: z.number().optional(),
  status: z.string(),
  total_point: z.number().optional(),
  available_point: z.number().optional(),
});

module.exports = { createCustomerSchema };
