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

// Runchise menerima nilai numerik sebagai string maupun number
// (contoh: discount_amount "100" / 10000, promotion_code_maximum_usage "10" / 1)
const numericValue = z.union([z.string(), z.number()]);

const anyObject = z.object({}).passthrough();

const maximumQtyAppliedSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    maximum_purchase: numericValue,
  })
  .passthrough();

const rewardProductSchema = z
  .object({
    product_id: z.number(),
    category_id: z.number().nullish(),
    quantity: numericValue,
  })
  .passthrough();

const promoRuleAttributesSchema = z
  .object({
    order_type_ids: z.array(z.number()).default([]),
    member_only: z.boolean().default(false),
    customer_categories: z.array(anyObject).default([]),
    payment_type_ids: z.array(z.number()).default([]),
    bin_promo_codes: z.array(z.unknown()).default([]),
    product_ids: z.array(z.number()).default([]),
    product_min_quantity: z.array(anyObject).default([]),
    product_condition: z.string().nullable().optional(),
    product_category_ids: z.array(z.number()).default([]),
    product_category_min_quantity: z.array(anyObject).default([]),
    product_category_condition: z.string().nullable().optional(),
    required_purchase_products: z.array(anyObject).default([]),
    required_purchase_product_categories: z.array(anyObject).default([]),
    total_min: numericValue.nullable().optional(),
    total_min_exclude_categories_ids: z.array(z.number()).default([]),
    maximum_redemption: numericValue.nullable().optional(),
    maximum_redemption_user: numericValue.nullable().optional(),
    user_target: z.string().nullable().optional(),
    maximum_redemption_type: z.string().optional(),
    maximum_redemption_limit: numericValue.optional(),
    maximum_redemption_location_setting: z.string().optional(),
    maximum_qty_applied_to_products: z
      .array(maximumQtyAppliedSchema)
      .default([]),
    maximum_qty_applied_to_product_categories: z
      .array(maximumQtyAppliedSchema)
      .default([]),
    exclude_product_ids: z.array(z.number()).default([]),
    exclude_product_category_ids: z.array(z.number()).default([]),
    use_promotion_code: z.boolean(),
    promotion_code_usage_type: z.string().optional(),
    promotion_code_source: z.string().optional(),
    promotion_code_number_of_generated_code: numericValue.optional(),
    promotion_code_maximum_usage: numericValue.optional(),
    promotion_code_uploaded_file: z.unknown().nullable().optional(),
    multiple_use_in_one_transaction: z.string().optional(),
    max_use_count: numericValue.optional(),
  })
  .passthrough();

const promoRewardAttributesSchema = z
  .object({
    template: z.string(),
    get_product_allow_multiple: z.boolean().optional(),
    discount_is_percentage: z.boolean().optional(),
    discount_amount: numericValue.optional(),
    discount_maximum: numericValue.nullable().optional(),
    discount_external_cost: numericValue.optional(),
    discount_in_house_cost: numericValue.optional(),
    get_product_ids: z.array(z.number()).default([]),
    get_product_category_ids: z.array(z.number()).default([]),
    reward_products: z.array(rewardProductSchema).default([]),
    free_of_charge: z.boolean().optional(),
    apply_to_option_set: z.boolean().optional(),
  })
  .passthrough();

const createPromoSchema = z
  .object({
    channel: z.string(),
    name: z.string().min(1),
    goal: z.enum(["increase_average_sale", "increase_number_sale"]),
    customer_allowed_dine_in: z.boolean().default(false),
    customer_allowed_online_ordering: z.boolean().default(false),
    applicable_for_loyalty: z.boolean().default(false),
    start_date: z
      .string()
      .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Format tanggal harus DD/MM/YYYY"),
    end_date: z
      .string()
      .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Format tanggal harus DD/MM/YYYY")
      .nullable(),
    subdize_promo_subject_mdr: z.boolean().default(false),
    is_select_all_location: z.boolean().default(true),
    location_type: z.string().default("outlet"),
    location_ids: z.array(z.number()).default([]),
    exclude_location_ids: z.array(z.number()).default([]),
    is_select_all_location_group: z.boolean().default(false),
    location_group_ids: z.array(z.number()).default([]),
    exclude_location_group_ids: z.array(z.number()).default([]),
    owner_location_id: z.number().int().positive(),
    promo_schedules: z.array(anyObject).nullable(),
    promo_rule_attributes: promoRuleAttributesSchema,
    promo_reward_attributes: promoRewardAttributesSchema,
  })
  .passthrough();

module.exports = { createCustomerSchema, createPromoSchema };
