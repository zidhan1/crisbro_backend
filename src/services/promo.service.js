const {
  createPromo,
  updatePromo,
  deactivatePromo,
  activatePromo,
  getListPromoCodes,
  getPromo,
  generatePromoCode,
} = require("./runchise.service");
const prisma = require("../lib/prisma");
const { z } = require("zod");
const { promoResponseSchema, promoCodesResponseSchema, remoteId } = require("../validation/promo/promo-response");
const { createPromoSchema, updatePromoSchema } = require("../validation/runchise/runchise-validation");
const { generatePromoCodeSchema } = require("../validation/promo/promo-code-validation");

function promoError(code, message, statusCode, cause) {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function formatPromo(record) {
  const { promoRule, promoReward, PromoCode, ...promo } = record;
  return {
    promo,
    promo_rule: promoRule ?? null,
    promo_reward: promoReward ?? null,
    ...(PromoCode === undefined ? {} : { promo_codes: PromoCode }),
  };
}

async function findPromo(promo_id, include) {
  const id = z.string().uuid("ID promo harus berupa UUID yang valid").parse(promo_id);
  const promo = await prisma.promo.findUnique({ where: { promo_id: id }, ...(include ? { include } : {}) });
  if (!promo) throw promoError("PROMO_NOT_FOUND", "Promo tidak ditemukan di database", 404);
  return promo;
}

// A failed local sync can be retried by remote ID without repeating remote create.
async function synchronizePromo(runchise_id, promo_id, response) {
  try {
    const raw = response ?? await getPromo(runchise_id);
    const promo = promoResponseSchema.parse(raw);
    if (promo.id !== runchise_id) throw new Error("ID promo dari Runchise tidak sesuai");
    const codes = promoCodesResponseSchema.parse(
      promo.promo_rule.use_promotion_code ? await getListPromoCodes(runchise_id) : [],
    );
    return await savePromo(promo, codes, promo_id);
  } catch (cause) {
    const error = promoError("PROMO_SYNC_FAILED", "Sinkronisasi lokal gagal; ulangi hanya sinkronisasi menggunakan runchise_id, jangan ulangi create atau generate promo code", 502, cause);
    error.runchise_id = runchise_id;
    throw error;
  }
}

async function syncPromoService(runchise_id) {
  return synchronizePromo(remoteId.parse(runchise_id));
}

async function generatePromoCodeService(promo_id, payload) {
  const { total_code } = generatePromoCodeSchema.parse(payload);
  const existing = await findPromo(promo_id, { promoRule: true });
  if (!existing.promoRule?.use_promotion_code) {
    throw promoError("PROMO_CODES_DISABLED", "Promo belum mengaktifkan penggunaan promotion code", 409);
  }

  await generatePromoCode({
    runchise_promo_id: existing.runchise_id,
    total_code,
  });

  return synchronizePromo(existing.runchise_id, existing.promo_id);
}

const listPromoQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(2147483647).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().default(""),
  status: z.string().trim().optional(),
  channel: z.string().trim().optional(),
  location_id: z.string().uuid().optional(),
  sort_by: z
    .enum([
      "created_at",
      "updated_at",
      "name",
      "status",
      "start_date",
      "end_date",
    ])
    .default("created_at"),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
});

async function createPromoService(payload) {
  const data = createPromoSchema.parse(payload);
  const response = await createPromo(data);
  if (!response) throw promoError("RUNCHISE_CREATE_FAILED", "Promo tidak berhasil dibuat di Runchise", 502);
  const id = remoteId.safeParse(response.id);
  if (!id.success) {
    throw promoError("INVALID_RUNCHISE_RESPONSE", "Respons create Runchise tidak memiliki ID promo yang valid; periksa Runchise sebelum mengulang create", 502, id.error);
  }
  return synchronizePromo(id.data, undefined, response);
}

async function listPromoService(query = {}) {
  const {
    page,
    limit,
    search,
    status,
    channel,
    location_id,
    sort_by,
    sort_order,
  } = listPromoQuerySchema.parse(query);
  const skip = (page - 1) * limit;
  if (skip > 2147483647) {
    throw promoError("INVALID_PAGINATION", "Halaman promo di luar batas pagination", 422);
  }

  const where = {};
  if (search) where.name = { contains: search, mode: "insensitive" };
  if (status) where.status = status;
  if (channel) where.channel = channel;
  if (location_id) where.location_ids = { has: location_id };

  const [promos, total] = await prisma.$transaction([
    prisma.promo.findMany({
      where,
      skip,
      take: limit,
      include: { promoRule: true, promoReward: true },
      orderBy: [{ [sort_by]: sort_order }, { promo_id: "asc" }],
    }),
    prisma.promo.count({ where }),
  ]);

  return {
    data: promos.map(formatPromo),
    meta: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

async function showPromoService(promo_id) {
  return formatPromo(await findPromo(promo_id, {
    promoRule: true, promoReward: true,
    PromoCode: { orderBy: { promo_code_id: "asc" } },
  }));
}

async function updatePromoService(promo_id, payload) {
  const data = updatePromoSchema.parse(payload);
  if (Object.keys(data).length === 0) throw promoError("EMPTY_UPDATE", "Minimal satu field harus dikirim untuk update promo", 422);
  const existing = await findPromo(promo_id);
  const response = await updatePromo(existing.runchise_id, data);
  // Read the full representation: a PATCH response may contain only changed fields.
  if (response?.id !== undefined && Number(response.id) !== existing.runchise_id) {
    throw promoError("RUNCHISE_ID_MISMATCH", "ID promo dari Runchise tidak sesuai", 502);
  }
  return synchronizePromo(existing.runchise_id, promo_id);
}

// Create dan update menggunakan pemetaan respons Runchise yang sama.
async function savePromo(runchisePromo, codes, promo_id) {
  const locationIds = [...new Set([
    runchisePromo.owner_location_id,
    ...runchisePromo.locations.map((location) => location.id),
  ])];
  const locations = await prisma.location.findMany({
    where: { runchise_id: { in: locationIds } },
    select: { runchise_id: true, location_id: true },
  });
  const byRemoteId = new Map(locations.map((location) => [location.runchise_id, location.location_id]));
  const missing = locationIds.filter((id) => !byRemoteId.has(id));
  if (missing.length) throw new Error(`Lokasi Runchise belum tersinkron: ${missing.join(", ")}`);
  const location_ids = [...new Set(runchisePromo.locations.map((location) => byRemoteId.get(location.id)))];
  const owner_location = { location_id: byRemoteId.get(runchisePromo.owner_location_id) };
  const runchise_products = runchisePromo.promo_reward.get_products.map((product) => product.name);
  const { start_date, end_date } = runchisePromo;

  try {
    const finalPromo = await prisma.$transaction(async (tx) => {
      const promoData = {
        runchise_id: runchisePromo.id,
        name: runchisePromo.name,
        goal: runchisePromo.goal,
        start_date: start_date,
        end_date: end_date,
        status: runchisePromo.status,
        owner_location_id: owner_location.location_id,
        location_type: runchisePromo.location_type,
        channel: runchisePromo.channel,
        location_ids: location_ids,
      };
      const promo = promo_id
        ? await tx.promo.update({ where: { promo_id }, data: promoData })
        : await tx.promo.upsert({
            where: { runchise_id: runchisePromo.id },
            create: promoData,
            update: promoData,
          });

      const ruleData = {
        promo_id: promo.promo_id,
        runchise_promo_rule_id: runchisePromo.promo_rule.id,
        order_types: JSON.stringify(runchisePromo.promo_rule.order_types),
        maximum_qty_applied_to_products: JSON.stringify(
          runchisePromo.promo_rule.maximum_qty_applied_to_products,
        ),
        use_promotion_code: runchisePromo.promo_rule.use_promotion_code,
        promotion_code_usage_type:
          runchisePromo.promo_rule.promotion_code_usage_type,
        promotion_code_source: runchisePromo.promo_rule.promotion_code_source,
        promotion_code_number_of_generated_code:
          runchisePromo.promo_rule.promotion_code_number_of_generated_code,
        promotion_code_maximum_usage:
          runchisePromo.promo_rule.promotion_code_maximum_usage,
        combine_promo_rule: runchisePromo.promo_rule.combine_promo_rule,
        member_only: runchisePromo.promo_rule.member_only,
        maximum_redemption_location_setting:
          runchisePromo.promo_rule.maximum_redemption_location_setting,
      };
      const promoRule = await tx.promoRule.upsert({
        where: { promo_id: promo.promo_id }, create: ruleData, update: ruleData,
      });

      const rewardData = {
        promo_id: promo.promo_id,
        runchise_promo_reward_id: runchisePromo.promo_reward.id,
        template: runchisePromo.promo_reward.template,
        free_of_charge: runchisePromo.promo_reward.free_of_charge,
        reward_product_condition:
          runchisePromo.promo_reward.reward_product_condition,
        discount_amount: runchisePromo.promo_reward.discount_amount,
        discount_is_percentage:
          runchisePromo.promo_reward.discount_is_percentage,
        discount_maximum: runchisePromo.promo_reward.discount_maximum,
        discount_in_house_cost:
          runchisePromo.promo_reward.discount_in_house_cost,
        discount_external_cost:
          runchisePromo.promo_reward.discount_external_cost,
        apply_to_option_set: runchisePromo.promo_reward.apply_to_option_set,
        get_products: runchise_products,
        get_product_allow_multiple:
          runchisePromo.promo_reward.get_product_allow_multiple,
        special_price_product_price:
          runchisePromo.promo_reward.special_price_product_price,
      };
      const promoReward = await tx.promoReward.upsert({
        where: { promo_id: promo.promo_id }, create: rewardData, update: rewardData,
      });
      const promoCodes = await savePromoCodes(tx, codes, promo.promo_id);
      return formatPromo({ ...promo, promoRule, promoReward, PromoCode: promoCodes });
    }, { timeout: 30000 });

    return finalPromo;
  } catch (cause) {
    throw promoError("PROMO_PERSIST_FAILED", "Gagal menyimpan promo di database", 500, cause);
  }
}

async function savePromoCodes(tx, codes, promo_id) {
  // Only insert new codes in bulk; existing codes need their mutable fields updated.
  const existing = codes.length ? await tx.promoCode.findMany({
    where: { runchise_id: { in: codes.map((code) => code.id) } },
    select: { runchise_id: true, promo_id: true },
  }) : [];
  if (existing.some((code) => code.promo_id !== promo_id)) {
    throw new Error("Promo code sudah terhubung ke promo lain");
  }
  const existingIds = new Set(existing.map((code) => code.runchise_id));
  const rows = codes.map(({ id, ...fields }) => ({ ...fields, runchise_id: id, promo_id }));
  const newRows = rows.filter((row) => !existingIds.has(row.runchise_id));
  for (let offset = 0; offset < newRows.length; offset += 100) {
    await tx.promoCode.createMany({ data: newRows.slice(offset, offset + 100) });
  }
  for (const row of rows.filter((row) => existingIds.has(row.runchise_id))) {
    const { runchise_id, promo_id: ownerId, ...data } = row;
    await tx.promoCode.update({ where: { runchise_id, promo_id: ownerId }, data });
  }
  // Preserve codes absent from this response: the remote endpoint may be paginated.
  return tx.promoCode.findMany({ where: { promo_id }, orderBy: { promo_code_id: "asc" } });
}

async function changePromoStatus(promo_id, changeStatus) {
  const existing = await findPromo(promo_id);
  if (!await changeStatus(existing.runchise_id)) {
    throw promoError("RUNCHISE_STATUS_FAILED", "Status promo tidak berhasil diubah di Runchise", 502);
  }
  return synchronizePromo(existing.runchise_id, promo_id);
}

async function deactivatePromoService(promo_id) {
  return changePromoStatus(promo_id, deactivatePromo);
}

async function activatePromoService(promo_id) {
  return changePromoStatus(promo_id, activatePromo);
}

module.exports = {
  createPromoService,
  listPromoService,
  showPromoService,
  updatePromoService,
  deactivatePromoService,
  activatePromoService,
  syncPromoService,
  generatePromoCodeService,
};
