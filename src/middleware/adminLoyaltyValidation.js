const { z } = require('zod');

const blankToUndefined = (value) =>
  value === '' || value === null ? undefined : value;
const optionalPositiveInt = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().positive().optional(),
);
const optionalNonNegativeInt = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().nonnegative().optional(),
);
const optionalDate = z.preprocess(
  blankToUndefined,
  z.coerce.date().optional(),
);
const optionalBoolean = z.preprocess(
  blankToUndefined,
  z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
);
const optionalNullableString = (max) =>
  z.union([z.string().max(max), z.null()]).optional();

const positiveIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const redeemItemListQuerySchema = z
  .object({
    sort_by: z.string().max(50).optional(),
    sort_order: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough();

const redeemItemCreateBodySchema = z
  .object({
    menu_item_id: z.coerce.number().int().positive(),
    category_id: optionalPositiveInt,
    points_required: z.coerce.number().int().positive(),
    is_active: optionalBoolean,
    badge: optionalNullableString(40),
    sort_order: optionalNonNegativeInt,
    start_at: optionalDate,
    end_at: optionalDate,
    stock_limit: optionalPositiveInt,
    daily_limit: optionalPositiveInt,
  })
  .strict();

const redeemItemUpdateBodySchema = redeemItemCreateBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Minimal satu field harus diisi',
  });

function validationMessage(error) {
  return error.issues
    .map((issue) => {
      const field = issue.path.join('.') || 'request';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

function validateRequest(schemas) {
  return (req, res, next) => {
    for (const [source, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        return res.status(400).json({
          message: `Request tidak valid — ${validationMessage(result.error)}`,
        });
      }
    }
    return next();
  };
}

const validateRedeemItemList = validateRequest({
  query: redeemItemListQuerySchema,
});
const validateRedeemItemCreate = validateRequest({
  body: redeemItemCreateBodySchema,
});
const validateRedeemItemUpdate = validateRequest({
  params: positiveIdParamsSchema,
  body: redeemItemUpdateBodySchema,
});
const validateRedeemItemId = validateRequest({ params: positiveIdParamsSchema });

module.exports = {
  validateRedeemItemCreate,
  validateRedeemItemId,
  validateRedeemItemList,
  validateRedeemItemUpdate,
};
