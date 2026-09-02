const bcrypt = require("bcrypt");
const prisma = require("../lib/prisma");
const { normalizePhone, phoneVariants } = require("../lib/phoneNumber");

const BCRYPT_ROUNDS = 10;
const ALLOWED_CREATE_FIELDS = [
  "email",
  "username",
  "password",
  "phone",
  "role",
  "referral_code",
  "no_referensi",
  "status",
];
const ALLOWED_UPDATE_FIELDS = [
  "email",
  "username",
  "password",
  "phone",
  "role",
  "referral_code",
  "no_referensi",
  "status",
];

function pickAllowedFields(payload = {}, allowedFields) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => allowedFields.includes(key)),
  );
}

async function createUserService(payload) {
  const data = pickAllowedFields(payload, ALLOWED_CREATE_FIELDS);

  if (Object.keys(data).length === 0) {
    throw new Error("No valid fields to create");
  }

  try {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: data.email }, { username: data.username }, { phone: data.phone }],
      },
    });

    if (existing)
      throw new Error("User with username/email/phone has been created.");

    if (data.password !== undefined) {
      data.password_hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
      delete data.password;
    }

    const user = await prisma.user.create({
      data,
    });

    return user;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function updateUserService(user_id, payload) {
  if (!user_id) throw new Error("user_id is required");

  const data = pickAllowedFields(payload, ALLOWED_UPDATE_FIELDS);

  if (Object.keys(data).length === 0) {
    throw new Error("No valid fields to update");
  }

  try {
    const user = await prisma.user.findUnique({
      where: { user_id: user_id },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Pastikan email/username/phone/referral_code/no_referensi tidak dipakai user lain
    const uniqueChecks = [];

    if (data.email !== undefined && data.email !== user.email) {
      uniqueChecks.push({ email: data.email });
    }
    if (data.username !== undefined && data.username !== user.username) {
      uniqueChecks.push({ username: data.username });
    }
    if (data.phone !== undefined) {
      const nextPhone = normalizePhone(data.phone);
      uniqueChecks.push({ phone: { in: phoneVariants(nextPhone) } });
      data.phone = nextPhone;
    }
    if (
      data.referral_code !== undefined &&
      data.referral_code !== user.referral_code
    ) {
      uniqueChecks.push({ referral_code: data.referral_code });
    }
    if (
      data.no_referensi !== undefined &&
      data.no_referensi !== user.no_referensi
    ) {
      uniqueChecks.push({ no_referensi: data.no_referensi });
    }

    if (uniqueChecks.length > 0) {
      const existing = await prisma.user.findFirst({
        where: {
          user_id: { not: user_id },
          OR: uniqueChecks,
        },
        select: { user_id: true },
      });

      if (existing) {
        throw new Error(
          "Email/username/phone/referral code/no referensi sudah dipakai user lain",
        );
      }
    }

    if (data.password !== undefined) {
      data.password_hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
      delete data.password;
    }

    const updated = await prisma.user.update({
      where: { user_id: user_id },
      data,
    });

    return updated;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

module.exports = { createUserService, updateUserService };
