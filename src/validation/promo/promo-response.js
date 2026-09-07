const { z } = require("zod");

const integer = z.union([z.number(), z.string().regex(/^\d+$/)])
  .pipe(z.coerce.number().int().min(0).max(2147483647));
const remoteId = integer.refine((value) => value > 0, "ID harus positif");
const numericString = z.union([
  z.number().finite(),
  z.string().regex(/^-?\d+(\.\d+)?$/),
]).transform(String).nullish();
const optionalString = z.string().nullish();
const optionalBoolean = z.boolean().nullish();

// Date-only values are stored at UTC midnight; timestamps must specify a zone.
const remoteDate = z.string().transform((value, ctx) => {
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  const parts = dmy ? [dmy[3], dmy[2], dmy[1]] : iso?.slice(1);
  const invalid = () => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Tanggal tidak valid; gunakan DD/MM/YYYY, YYYY-MM-DD, atau ISO dengan timezone" });
    return z.NEVER;
  };
  if (!parts) return invalid();
  const [year, month, day] = parts.map(Number);
  const dateOnly = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const calendar = new Date(`${dateOnly}T00:00:00.000Z`);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return invalid();
  if (!dmy && value.includes("T") && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return invalid();
  const date = !dmy && value.includes("T") ? new Date(value) : calendar;
  return Number.isNaN(date.getTime()) ? invalid() : date;
}).nullish();

const objectArray = z.array(z.object({}).passthrough()).nullable().transform((value) => value ?? []);
const promoRuleResponseSchema = z.object({
  id: remoteId,
  order_types: objectArray,
  maximum_qty_applied_to_products: objectArray,
  use_promotion_code: z.boolean(),
  promotion_code_usage_type: optionalString,
  promotion_code_source: optionalString,
  promotion_code_number_of_generated_code: integer.nullish(),
  promotion_code_maximum_usage: integer.nullish(),
  combine_promo_rule: optionalString,
  member_only: optionalBoolean,
  maximum_redemption_location_setting: optionalString,
});
const promoRewardResponseSchema = z.object({
  id: remoteId,
  template: optionalString,
  free_of_charge: optionalBoolean,
  reward_product_condition: optionalString,
  discount_amount: numericString,
  discount_is_percentage: optionalBoolean,
  discount_maximum: numericString,
  discount_in_house_cost: numericString,
  discount_external_cost: numericString,
  apply_to_option_set: optionalBoolean,
  get_products: z.array(z.object({ name: z.string() })).nullable().transform((value) => value ?? []),
  get_product_allow_multiple: optionalBoolean,
  special_price_product_price: numericString,
});
const promoResponseSchema = z.object({
  id: remoteId,
  name: optionalString,
  goal: optionalString,
  start_date: remoteDate,
  end_date: remoteDate,
  status: z.string().min(1),
  owner_location_id: remoteId,
  location_type: optionalString,
  channel: optionalString,
  locations: z.array(z.object({ id: remoteId })),
  promo_rule: promoRuleResponseSchema,
  promo_reward: promoRewardResponseSchema,
});
const promoCodesResponseSchema = z.array(z.object({
  id: remoteId,
  code: optionalString,
  usage_type: optionalString,
  status: optionalString,
  maximum_usage: integer.nullish(),
  number_of_usage: integer.nullish(),
  last_usage: remoteDate,
  deactivate_at: remoteDate,
  deactivate_reason: optionalString,
})).superRefine((codes, ctx) => {
  if (new Set(codes.map((code) => code.id)).size !== codes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ID promo code duplikat dalam respons" });
  }
});

module.exports = { promoResponseSchema, promoCodesResponseSchema, remoteId, remoteDate };
