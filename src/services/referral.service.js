const prisma = require("../lib/prisma");
const { generateRandomUniqueCode } = require("../utils/generateReferralCode");
const { findCustomerByPhone } = require("./runchise.service");
const { normalizePhone } = require("../lib/phoneNumber");

function optionalInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function optionalDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pointBalance(remoteValue, localValue, awardedPoints) {
  const remotePoints = optionalInteger(remoteValue);
  const localPoints = optionalInteger(localValue) ?? 0;
  return (remotePoints ?? localPoints) + awardedPoints;
}

function buildCustomerUpdateFromRunchise(
  remoteCustomer,
  localCustomer,
  awardedPoints,
) {
  return {
    runchise_id: optionalInteger(remoteCustomer.id),
    runchise_location_id: optionalInteger(remoteCustomer.owner_location_id),
    runchise_synced_at: new Date(),
    name: remoteCustomer.name,
    phone_number: remoteCustomer.phone_number,
    normalized_phone_number: normalizePhone(remoteCustomer.phone_number),
    address: remoteCustomer.address,
    province: remoteCustomer.province,
    city: remoteCustomer.city,
    country: remoteCustomer.country,
    postal_code: remoteCustomer.postal_code,
    dob: optionalDate(remoteCustomer.dob),
    gender: remoteCustomer.gender,
    status: remoteCustomer.status,
    balance: remoteCustomer.balance,
    member_since: optionalDate(remoteCustomer.member_since),
    total_point: pointBalance(
      remoteCustomer.total_point,
      localCustomer.total_point,
      awardedPoints,
    ),
    available_point: pointBalance(
      remoteCustomer.available_point,
      localCustomer.available_point,
      awardedPoints,
    ),
  };
}

async function generateReferralCodeService({ user_id, payload }) {
  try {
    if (!user_id) return { code: 422, message: "User ID is required" };

    // Find user
    const user = await prisma.user.findUnique({ where: { user_id: user_id } });

    if (!user) return { code: 404, message: "User not found" };

    // Generate code
    let code;
    let exist = true;
    while (exist) {
      code = generateRandomUniqueCode();
      exist = await prisma.user.findUnique({ where: { referral_code: code } });
    }

    // Check referral program user
    let refProgram = await prisma.referralProgram.findUnique({
      where: { owner_referral: user_id },
    });

    if (refProgram)
      return {
        code: 400,
        message: "Referral program has been created for this user",
      };

    // Create referral program for this user
    refProgram = await prisma.referralProgram.create({
      data: payload,
    });

    // Insert referral code to user
    const userWithReferral = await prisma.user.update({
      where: { user_id: user_id },
      data: { referral_code: code },
    });

    const data = {
      user_id: userWithReferral.user_id,
      username: userWithReferral.username,
      email: userWithReferral.email,
      phone: userWithReferral.phone,
      referral_code: userWithReferral.referral_code,
      referral_expires_at: refProgram.expires_at,
    };

    return { code: 200, data: data };
  } catch (err) {
    throw new Error(err);
  }
}

async function renewReferralCodeService({ user_id, payload }) {
  try {
    if (!user_id) return { code: 422, message: "User ID is required" };

    // Find user
    const user = await prisma.user.findUnique({ where: { user_id: user_id } });

    if (!user) return { code: 404, message: "User not found" };

    // Generate code
    let code;
    let exist = true;
    while (exist) {
      code = generateRandomUniqueCode();
      exist = await prisma.user.findUnique({ where: { referral_code: code } });
    }

    // Check referral program user
    let refProgram = await prisma.referralProgram.findUnique({
      where: { owner_referral: user_id },
    });

    if (!refProgram) {
      return { code: 404, message: "Referral program not found" };
    }

    // Renewal is only allowed after the current referral code has expired.
    const now = new Date();
    if (refProgram.expires_at > now)
      return {
        code: 400,
        message: "The referral code has not expired.",
      };

    // Create referral program for this user
    refProgram = await prisma.referralProgram.update({
      where: { owner_referral: user_id },
      data: payload,
    });

    // Insert referral code to user
    const userWithReferral = await prisma.user.update({
      where: { user_id: user_id },
      data: { referral_code: code },
    });

    const data = {
      user_id: userWithReferral.user_id,
      username: userWithReferral.username,
      email: userWithReferral.email,
      phone: userWithReferral.phone,
      referral_code: userWithReferral.referral_code,
      referral_expires_at: refProgram.expires_at,
    };

    return { code: 200, data: data };
  } catch (err) {
    throw new Error("Failed to renew referral code", { cause: err });
  }
}

async function validateReferralCodeService({ user_id }) {
  if (!user_id) return { code: 422, message: "User ID is required" };

  const pendingReferral = await prisma.referral.findFirst({
    where: {
      referred_id: user_id,
      status: "pending",
      program: { owner_referral: { not: user_id } },
    },
    select: {
      referral_id: true,
      referral_program_id: true,
      point_awarded: true,
      program: {
        select: {
          owner_referral: true,
          point_reward: true,
          point_given: true,
        },
      },
    },
  });

  if (!pendingReferral) {
    return { code: 404, message: "Pending referral not found" };
  }

  const referrerUserId = pendingReferral.program.owner_referral;
  const participantIds = [referrerUserId, user_id];

  // Data lama menyimpan reward user baru sebagai row reciprocal. Row itu tetap
  // diproses agar deployment tidak meninggalkan referral pending, tetapi data
  // baru hanya membuat satu row dengan relasi referrer/referred yang benar.
  const [legacyReverseReferral, users] = await Promise.all([
    prisma.referral.findFirst({
      where: {
        referral_program_id: pendingReferral.referral_program_id,
        status: "pending",
        referrer_id: user_id,
        referred_id: referrerUserId,
      },
      select: { referral_id: true, point_awarded: true },
    }),
    prisma.user.findMany({
      where: { user_id: { in: participantIds } },
      select: {
        user_id: true,
        phone: true,
        phone_verified: true,
        status: true,
        customer: {
          select: {
            customer_id: true,
            phone_number: true,
            total_point: true,
            available_point: true,
          },
        },
      },
    }),
  ]);

  const userById = new Map(users.map((user) => [user.user_id, user]));
  const participants = participantIds.map((participantId) =>
    userById.get(participantId),
  );

  if (
    participants.some(
      (user) => !user?.customer || !(user.phone || user.customer.phone_number),
    )
  ) {
    return {
      code: 409,
      message: "Referral participant customer data is incomplete",
    };
  }

  const referredUser = participants[1];
  if (!referredUser.phone_verified || referredUser.status !== "active") {
    return {
      code: 409,
      message: "Referred user has not completed phone verification",
    };
  }

  const remoteCustomers = await Promise.all(
    participants.map((user) =>
      findCustomerByPhone({
        phone: user.phone || user.customer.phone_number,
      }),
    ),
  );

  if (remoteCustomers.some((customer) => !customer)) {
    return {
      code: 404,
      message: "One or more customers were not found in Runchise",
    };
  }

  const completedAt = new Date();
  const referralIds = [
    pendingReferral.referral_id,
    ...(legacyReverseReferral ? [legacyReverseReferral.referral_id] : []),
  ];
  const awardedPoints = [
    pendingReferral.program.point_reward,
    pendingReferral.point_awarded,
  ];

  const completedCount = await prisma
    .$transaction(async (tx) => {
      const referralUpdate = await tx.referral.updateMany({
        where: {
          referral_id: { in: referralIds },
          status: "pending",
        },
        data: { status: "completed" },
      });

      if (referralUpdate.count !== referralIds.length) {
        const conflict = new Error("Referral was already processed");
        conflict.code = "REFERRAL_ALREADY_PROCESSED";
        throw conflict;
      }

      await Promise.all(
        participants.map((user, index) =>
          tx.customer.update({
            where: { customer_id: user.customer.customer_id },
            data: buildCustomerUpdateFromRunchise(
              remoteCustomers[index],
              user.customer,
              awardedPoints[index],
            ),
          }),
        ),
      );

      return referralUpdate.count;
    })
    .catch((error) => {
      if (error.code === "REFERRAL_ALREADY_PROCESSED") return 0;
      throw error;
    });

  if (completedCount === 0) {
    return { code: 409, message: "Referral was already processed" };
  }

  return {
    code: 200,
    data: {
      referral_program_id: pendingReferral.referral_program_id,
      referrer_user_id: referrerUserId,
      referred_user_id: user_id,
      completed_referrals: completedCount,
      customers_synced: participants.length,
      points_awarded: {
        referrer: awardedPoints[0],
        referred: awardedPoints[1],
      },
      completed_at: completedAt,
    },
  };
}

async function getReferralCodesByReferredIdService({ referred_id }) {
  if (!referred_id) {
    return { code: 422, message: "Referred user ID is required" };
  }

  const referrals = await prisma.referral.findMany({
    where: { referred_id },
    orderBy: { created_at: "desc" },
    select: {
      referral_id: true,
      referred_id: true,
      point_awarded: true,
      status: true,
      created_at: true,
      referrer: {
        select: {
          user_id: true,
          username: true,
          referral_code: true,
        },
      },
      program: {
        select: {
          referral_id: true,
          point_reward: true,
          point_given: true,
          expires_at: true,
        },
      },
    },
  });

  return {
    code: 200,
    data: referrals.map((referral) => ({
      referral_id: referral.referral_id,
      referral_code: referral.referrer.referral_code,
      referrer: {
        user_id: referral.referrer.user_id,
        username: referral.referrer.username,
      },
      referred_id: referral.referred_id,
      status: referral.status,
      point_awarded_to_referrer: referral.program.point_reward,
      point_given_to_referred: referral.point_awarded,
      expires_at: referral.program.expires_at,
      created_at: referral.created_at,
    })),
  };
}

async function listReferralCodeUsagesService({ status } = {}) {
  const referrals = await prisma.referral.findMany({
    where: status ? { status } : undefined,
    orderBy: { created_at: "desc" },
    select: {
      referral_id: true,
      point_awarded: true,
      status: true,
      created_at: true,
      referrer: {
        select: {
          user_id: true,
          username: true,
          referral_code: true,
        },
      },
      referred: {
        select: {
          user_id: true,
          username: true,
          phone: true,
          phone_verified: true,
          status: true,
        },
      },
      program: {
        select: {
          referral_id: true,
          owner_referral: true,
          point_reward: true,
          point_given: true,
          expires_at: true,
        },
      },
    },
  });

  // Pada data yang benar, pemilik program selalu sama dengan referrer. Filter
  // ini mencegah row reciprocal dari implementasi lama tampil sebagai pemakai
  // kode referral kedua.
  const usages = referrals
    .filter(
      (referral) =>
        referral.program.owner_referral === referral.referrer.user_id,
    )
    .map((referral) => ({
      referral_id: referral.referral_id,
      referral_code: referral.referrer.referral_code,
      status: referral.status,
      referrer: {
        user_id: referral.referrer.user_id,
        username: referral.referrer.username,
        point_reward: referral.program.point_reward,
      },
      referred: {
        user_id: referral.referred.user_id,
        username: referral.referred.username,
        phone: referral.referred.phone,
        phone_verified: referral.referred.phone_verified,
        account_status: referral.referred.status,
        point_given: referral.point_awarded,
      },
      expires_at: referral.program.expires_at,
      created_at: referral.created_at,
      can_validate:
        referral.status === "pending" &&
        referral.referred.phone_verified &&
        referral.referred.status === "active",
    }));

  return {
    code: 200,
    data: usages,
    meta: {
      total: usages.length,
      status: status ?? "all",
    },
  };
}

module.exports = {
  generateReferralCodeService,
  renewReferralCodeService,
  validateReferralCodeService,
  getReferralCodesByReferredIdService,
  listReferralCodeUsagesService,
};
