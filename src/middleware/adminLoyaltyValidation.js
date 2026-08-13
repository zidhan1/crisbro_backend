const { z } = require('zod');

// L-7: skema boundary untuk SELURUH rute admin loyalty, bukan lagi hanya rute
// redeem item. Pola yang dipakai sama persis dengan versi sebelumnya dan tidak
// diubah: middleware ini HANYA memvalidasi (`safeParse`) dan tidak pernah
// menulis balik hasil parse ke `req`, sehingga controller tetap memakai parser
// manualnya sendiri sebagai lapisan kedua (defense in depth) dan tetap bisa
// dipanggil langsung oleh unit test tanpa melewati Express.
//
// Aturan pembagian tanggung jawab yang dipertahankan dari desain lama:
//   - Skema di sini menjaga BENTUK request (tipe primitif, batas panjang,
//     rentang angka, field liar).
//   - Aturan domain yang punya pesan khusus untuk pengguna tetap di controller
//     (mis. `email_status`, `role`, `status` redemption, panjang password,
//     "email atau nomor telepon wajib diisi"). Skema sengaja dibuat permisif
//     pada field-field itu supaya pesan errornya tidak berubah.

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

// Query string selalu bertipe string. `.max()` mengikuti batas yang sama dengan
// parser manual di controller supaya tidak ada request yang lolos di sini tapi
// ditolak di controller (atau sebaliknya).
const optionalQueryText = (max) => z.string().max(max).optional();
// Halaman/limit dibiarkan `optional` karena controller memberi default sendiri
// (`req.query.page ?? 1`) dan melakukan clamp batas atas.
const paginationQueryShape = {
  page: optionalPositiveInt,
  limit: optionalPositiveInt,
};
// `sort_by` sengaja string bebas: controller memetakan nilai tak dikenal ke
// urutan default (`buildAdminUserOrderBy` dkk.), jadi meng-enum-kannya di sini
// akan mengubah perilaku dari "fallback diam-diam" menjadi 400.
const sortQueryShape = {
  sort_by: optionalQueryText(50),
  sort_order: z.enum(['asc', 'desc']).optional(),
};
const dateRangeQueryShape = {
  from: optionalDate,
  to: optionalDate,
};

const positiveIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ===================== USER ADMIN =====================

const adminUserListQuerySchema = z
  .object({
    search: optionalQueryText(100),
    ...sortQueryShape,
    ...paginationQueryShape,
  })
  .passthrough();

const adminUserCreateBodySchema = z
  .object({
    email: optionalNullableString(255),
    phone_number: optionalNullableString(30),
    password: z.string().max(255),
    // Enum role divalidasi controller (`parseAdminUserRole`) agar pesannya tetap
    // "role harus admin atau marketing".
    role: z.string().max(30).optional(),
  })
  .strict();

// Sengaja `.passthrough()`: penolakan field liar untuk endpoint ini sudah jadi
// milik controller (`Field tidak diizinkan: ...`), termasuk pesannya. Skema di
// sini hanya menambahkan pemeriksaan tipe untuk empat field yang dikenal.
const adminUserUpdateBodySchema = z
  .object({
    email: optionalNullableString(255),
    phone_number: optionalNullableString(30),
    password: z.string().max(255).optional(),
    role: z.string().max(30).optional(),
  })
  .passthrough();

const activityLogListQuerySchema = z
  .object({
    search: optionalQueryText(100),
    action: optionalQueryText(80),
    entity_type: optionalQueryText(80),
    actor_user_id: optionalPositiveInt,
    ...dateRangeQueryShape,
    ...paginationQueryShape,
  })
  .passthrough();

// ===================== CUSTOMER =====================

const customerListQuerySchema = z
  .object({
    search: optionalQueryText(100),
    // Enum `all|missing|present` tetap divalidasi controller supaya pesannya
    // tidak berubah.
    email_status: optionalQueryText(20),
    ...sortQueryShape,
    ...dateRangeQueryShape,
    ...paginationQueryShape,
  })
  .passthrough();

// Catatan kebijakan:
// Field saldo dan poin tidak diterima sebagai bagian dari pembaruan profil.
// Saldo dan poin sengaja tidak termasuk field profil yang dapat ditulis admin.
// Controller juga menolaknya secara eksplisit untuk melindungi klien lama.
const customerWritableBodyShape = {
  name: z.string().max(120).optional(),
  email: optionalNullableString(255),
  phone_number: optionalNullableString(30),
  phone_number_country_code: optionalPositiveInt,
  address: optionalNullableString(1000),
  province: optionalNullableString(120),
  city: optionalNullableString(120),
  country: optionalNullableString(120),
  postal_code: optionalNullableString(20),
  // `optionalDate`/`optionalPositiveInt` sudah memetakan ''/null ke undefined,
  // jadi payload frontend yang mengirim null tetap diterima apa adanya.
  dob: optionalDate,
  gender: z.string().max(30).optional(),
  status: z.string().max(30).optional(),
  brand_id: optionalPositiveInt,
  owner_location_id: optionalPositiveInt,
  location_ids: z.array(z.coerce.number()).optional(),
};

const customerCreateBodySchema = z
  .object(customerWritableBodyShape)
  .passthrough();
const customerUpdateBodySchema = z
  .object(customerWritableBodyShape)
  .passthrough();

const salesTransactionReportQuerySchema = z
  .object({
    search: optionalQueryText(100),
    outlet: optionalQueryText(120),
    ...dateRangeQueryShape,
    ...paginationQueryShape,
  })
  .passthrough();

// ===================== RINGKASAN LOYALTY =====================

const loyaltySummaryQuerySchema = z
  .object({
    redemption_from: optionalDate,
    redemption_to: optionalDate,
    outlet_id: optionalPositiveInt,
    redemption_history_page: optionalPositiveInt,
    redemption_history_limit: optionalPositiveInt,
  })
  .passthrough();

// ===================== REWARDS CATALOG =====================

const rewardListQuerySchema = z.object(paginationQueryShape).passthrough();

const rewardCreateBodySchema = z
  .object({
    brand_id: optionalPositiveInt,
    name: z.string().max(120),
    description: optionalNullableString(1000),
    points_required: z.coerce.number().int().positive(),
    image_url: optionalNullableString(1000),
    is_active: optionalBoolean,
  })
  .strict();

const rewardUpdateBodySchema = rewardCreateBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Minimal satu field harus diisi',
  });

// ===================== REDEEM MENU =====================

const catalogMenuItemQuerySchema = z
  .object({
    search: optionalQueryText(100),
    limit: optionalPositiveInt,
  })
  .passthrough();

const redeemCategoryListQuerySchema = z
  .object(paginationQueryShape)
  .passthrough();

const redeemCategoryCreateBodySchema = z
  .object({
    name: z.string().max(80),
    sort_order: optionalNonNegativeInt,
    is_active: optionalBoolean,
  })
  .strict();

const redeemCategoryUpdateBodySchema = redeemCategoryCreateBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Minimal satu field harus diisi',
  });

const redeemItemListQuerySchema = z
  .object({
    ...sortQueryShape,
    ...paginationQueryShape,
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

const redemptionListQuerySchema = z
  .object({
    // Enum status tetap divalidasi controller ("status tidak valid").
    status: optionalQueryText(30),
    ...paginationQueryShape,
  })
  .passthrough();

const redemptionStatusBodySchema = z
  .object({
    status: z.string().max(30),
  })
  .strict();

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

const validateIdParam = validateRequest({ params: positiveIdParamsSchema });

module.exports = {
  validateRequest,

  // User admin & activity log
  validateAdminUserList: validateRequest({ query: adminUserListQuerySchema }),
  validateAdminUserCreate: validateRequest({ body: adminUserCreateBodySchema }),
  validateAdminUserUpdate: validateRequest({
    params: positiveIdParamsSchema,
    body: adminUserUpdateBodySchema,
  }),
  validateActivityLogList: validateRequest({
    query: activityLogListQuerySchema,
  }),

  // Customer
  validateCustomerList: validateRequest({ query: customerListQuerySchema }),
  validateCustomerCreate: validateRequest({ body: customerCreateBodySchema }),
  validateCustomerUpdate: validateRequest({
    params: positiveIdParamsSchema,
    body: customerUpdateBodySchema,
  }),
  validateSalesTransactionReportList: validateRequest({
    query: salesTransactionReportQuerySchema,
  }),

  // Ringkasan
  validateLoyaltySummary: validateRequest({ query: loyaltySummaryQuerySchema }),

  // Rewards catalog
  validateRewardList: validateRequest({ query: rewardListQuerySchema }),
  validateRewardCreate: validateRequest({ body: rewardCreateBodySchema }),
  validateRewardUpdate: validateRequest({
    params: positiveIdParamsSchema,
    body: rewardUpdateBodySchema,
  }),

  // Redeem menu
  validateCatalogMenuItemList: validateRequest({
    query: catalogMenuItemQuerySchema,
  }),
  validateRedeemCategoryList: validateRequest({
    query: redeemCategoryListQuerySchema,
  }),
  validateRedeemCategoryCreate: validateRequest({
    body: redeemCategoryCreateBodySchema,
  }),
  validateRedeemCategoryUpdate: validateRequest({
    params: positiveIdParamsSchema,
    body: redeemCategoryUpdateBodySchema,
  }),
  validateRedeemItemCreate: validateRequest({ body: redeemItemCreateBodySchema }),
  validateRedeemItemId: validateIdParam,
  validateRedeemItemList: validateRequest({ query: redeemItemListQuerySchema }),
  validateRedeemItemUpdate: validateRequest({
    params: positiveIdParamsSchema,
    body: redeemItemUpdateBodySchema,
  }),
  validateRedemptionList: validateRequest({ query: redemptionListQuerySchema }),
  validateRedemptionStatusUpdate: validateRequest({
    params: positiveIdParamsSchema,
    body: redemptionStatusBodySchema,
  }),

  // Params-only (aktivasi ulang, retry sync, hapus)
  validateIdParam,
};
