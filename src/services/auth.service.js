const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const getJwtSecret = require("../lib/jwtSecret");
const { normalizePhone, phoneVariants } = require("../lib/phoneNumber");
const { getSessionPolicy } = require("../lib/sessionPolicy");
const { getNextReward } = require("./nextRewardService");
const { sendReferralValidationEmail } = require("./email.service");
const { findCustomerByPhone, createCustomer } = require("./runchise.service");
const {
  generateOtpCode,
  sendOtpCode,
  verifyOtpCode,
} = require("./fazpass.service");
const { generateRandomUniqueCode } = require("../utils/generateReferralCode");

const INVALID_CREDENTIALS_MESSAGE =
  "Email/nomor telepon atau password salah. Bila akun Anda belum pernah diaktivasi, hubungi Admin untuk menerima tautan aktivasi.";
const DUMMY_PASSWORD_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const BCRYPT_ROUNDS = 10;

class AuthServiceError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "AuthServiceError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function hasUsablePassword(user) {
  return typeof user?.password_hash === "string" && user.password_hash !== "";
}

function getFazpassGatewayKey() {
  return process.env.FAZPASS_GATEWEY_KEY;
}

function buildLocalCustomerData(remoteCustomer, userId, fallbackPhone) {
  return {
    user_id: userId,
    runchise_id: remoteCustomer.id,
    runchise_location_id: remoteCustomer.owner_location_id,
    name: remoteCustomer.name,
    phone_number:
      remoteCustomer.phone_number ??
      remoteCustomer.phoneNumber ??
      fallbackPhone,
    total_point: remoteCustomer.total_point ?? 0,
    available_point: remoteCustomer.available_point ?? 0,
  };
}

async function getReferralRegistrationData(referralCode) {
  if (!referralCode) return null;

  const referrer = await prisma.user.findUnique({
    where: { referral_code: referralCode },
    select: {
      user_id: true,
      referral_program: {
        select: {
          referral_id: true,
          expires_at: true,
          point_reward: true,
          point_given: true,
        },
      },
    },
  });

  if (!referrer) {
    throw new AuthServiceError(404, "Referral code tidak ditemukan");
  }

  if (!referrer.referral_program) {
    throw new AuthServiceError(
      404,
      "Tidak ditemukan program referral tersebut",
    );
  }

  if (referrer.referral_program.expires_at < new Date()) {
    throw new AuthServiceError(400, "Referral code tersebut sudah kadaluwarsa");
  }

  return {
    referrerId: referrer.user_id,
    programId: referrer.referral_program.referral_id,
    pointReward: referrer.referral_program.point_reward,
    pointGiven: referrer.referral_program.point_given,
  };
}

async function registerUser(data) {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { phone: data.phone },
        { email: data.email },
        { username: data.username },
      ],
    },
    select: { user_id: true },
  });

  if (existing) {
    throw new AuthServiceError(400, "Phone / email / username sudah terdaftar");
  }

  const referralData = await getReferralRegistrationData(data.referral_code);
  let remoteCustomer = await findCustomerByPhone({ phone: data.phone });

  // Initialize point for new member
  let pointNewMember = 0;

  if (!remoteCustomer) {
    remoteCustomer = await createCustomer({
      name: data.name,
      phone_number: data.phone,
      email: data.email,
      owner_location_id: data.location_id,
      status: "active",
    });
    pointNewMember = 1;
  }

  if (!remoteCustomer) {
    throw new AuthServiceError(502, "Gagal membuat customer di Runchise");
  }

  const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
  const { user, referral } = await prisma.$transaction(async (tx) => {
    // Public registration always creates a customer account. Privileged roles
    // must be provisioned through an authenticated administrative flow.
    const createdUser = await tx.user.create({
      data: {
        username: data.username,
        email: data.email,
        phone: data.phone,
        role: "customer",
        password_hash: passwordHash,
      },
    });

    await tx.customer.create({
      data: buildLocalCustomerData(
        remoteCustomer,
        createdUser.user_id,
        data.phone,
      ),
    });

    let createdReferralRecord = [];
    if (referralData) {
      // For referred
      const referred = await tx.referral.create({
        data: {
          referral_program_id: referralData.programId,
          referrer_id: referralData.referrerId,
          referred_id: createdUser.user_id,
          // Referral row belongs to the newly referred user, so its stored
          // point value is the amount given to that user.
          point_awarded: referralData.pointGiven + pointNewMember,
          status: "pending",
        },
      });

      // For referrer
      const referrer = await tx.referral.create({
        data: {
          referral_program_id: referralData.programId,
          referrer_id: createdUser.user_id,
          referred_id: referralData.referrerId,
          point_awarded: referralData.pointReward,
          status: "pending",
        },
      });

      createdReferralRecord.push(referred, referrer);
    }

    const createdReferral =
      createdReferralRecord.length !== 0
        ? {
            ...createdReferralRecord,
            rewards: {
              referrer: {
                user_id: referralData.referrerId,
                point_reward: referralData.pointReward,
              },
              referred: {
                user_id: createdUser.user_id,
                point_given: referralData.pointGiven,
              },
            },
          }
        : null;

    return { user: createdUser, referral: createdReferral };
  });

  // Generate no reference for activation user
  noRef = generateRandomUniqueCode(10);

  let code;
  let exist = true;
  while (exist) {
    code = generateRandomUniqueCode(10);
    exist = await prisma.user.findUnique({ where: { no_referensi: code } });
  }

  await prisma.user.update({
    where: { user_id: user.user_id },
    data: {
      no_referensi: code,
    },
  });

  const userWithReference = await prisma.user.update({
    where: { user_id: user.user_id },
    data: { no_referensi: code },
    select: {
      user_id: true,
      email: true,
      username: true,
      phone: true,
      role: true,
      email_verification_token: true,
      email_verification_expires: true,
      email_verified: true,
      referral_code: true,
      otp: true,
      otp_expires: true,
      otp_id: true,
      phone_verified: true,
      status: true,
      created_at: true,
      updated_at: true,
    },
  });

  const defaultText = `AKTIVASI CRISBRO\n
                       Harap kirim pesan ini tanpa merubah apapun.\n 
                       No.ref:${userWithReference.no_referensi}`;

  return { user: userWithReference, referral, text: defaultText };
}

async function sendUserReferenceCode(userId) {
  if (!userId) throw new AuthServiceError(400, "user_id is required");

  const user = await prisma.user.findUnique({ where: { user_id: userId } });
  if (!user) throw new AuthServiceError(404, "User not found");

  noRef = generateRandomUniqueCode(10);

  let code;
  let exist = true;
  while (exist) {
    code = generateRandomUniqueCode(10);
    exist = await prisma.user.findUnique({ where: { no_referensi: code } });
  }

  const userReference = await prisma.user.update({
    where: { user_id: userId },
    data: {
      no_referensi: code,
    },
  });

  const defaultText = `AKTIVASI CRISBRO\n
                       Harap kirim pesan ini tanpa merubah apapun.\n 
                       No.ref:${userReference.no_referensi}`;

  return { user: userReference, text: defaultText };
}

async function notifyMarketingAboutReferral(userId) {
  const referral = await prisma.referral.findFirst({
    where: { referred_id: userId, status: "pending" },
    include: { referrer: true, referred: true },
  });
  if (!referral) return;

  const recipients = await prisma.user.findMany({
    where: { role: "marketing", status: "active" },
    select: { email: true },
  });

  await Promise.allSettled(
    recipients.map(({ email }) =>
      sendReferralValidationEmail({
        to: email,
        referrer: {
          name: referral.referrer.username,
          phone: referral.referrer.phone,
        },
        referred: {
          name: referral.referred.username,
          phone: referral.referred.phone,
        },
        referralCode: referral.referrer.referral_code,
        validationUrl:
          process.env.REFERRAL_VALIDATION_URL ||
          "https://crisbro-frontend.vercel.app",
      }),
    ),
  );
}

async function verifyUserPhone({ raw_phone, noRef }) {
  if (!raw_phone) throw new AuthServiceError(400, "phone is required");
  if (!noRef) throw new AuthServiceError(400, "noRef is required");

  const phone = normalizePhone(raw_phone);

  const user = await prisma.user.findUnique({
    where: { phone: phone, no_referensi: noRef },
  });

  if (!user) throw new AuthServiceError(404, "User not found");

  if (user.status === "active")
    throw new AuthServiceError(400, "User has been activate");

  const verifiedUser = await prisma.user.update({
    where: { user_id: user.user_id },
    data: { phone_verified: true, status: "active" },
  });

  await notifyMarketingAboutReferral(user.user_id);
  return verifiedUser;
}

function parseLoginIdentity({ email: rawEmail, phone: rawPhone }) {
  const email =
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const phone = normalizePhone(rawPhone);
  const isEmailLogin = email !== "";
  const isPhoneLogin = Boolean(phone);

  if (
    isEmailLogin === isPhoneLogin ||
    (isEmailLogin && !/^[^\s@]+@crisbar\.id$/i.test(email)) ||
    (isPhoneLogin && !phone.startsWith("8"))
  ) {
    throw new AuthServiceError(
      400,
      "Gunakan salah satu: nomor telepon yang diawali 8, atau email marketing @crisbar.id.",
    );
  }

  return { email, phone, isEmailLogin };
}

async function authenticateUser({ email, phone, password }) {
  if (typeof password !== "string" || password.trim() === "") {
    throw new AuthServiceError(400, "Password wajib diisi");
  }

  const identity = parseLoginIdentity({ email, phone });
  const credentials = await prisma.user.findFirst({
    where: identity.isEmailLogin
      ? {
          email: { equals: identity.email, mode: "insensitive" },
          OR: [
            {
              role: "marketing",
            },
            {
              role: "admin",
            },
          ],
        }
      : { phone: { in: phoneVariants(identity.phone) } },
    orderBy: { user_id: "asc" },
    select: { user_id: true, password_hash: true },
  });

  const canAuthenticate = hasUsablePassword(credentials);
  const validPassword = await bcrypt.compare(
    password,
    canAuthenticate ? credentials.password_hash : DUMMY_PASSWORD_HASH,
  );

  if (!canAuthenticate || !validPassword) {
    throw new AuthServiceError(401, INVALID_CREDENTIALS_MESSAGE);
  }

  const user = await prisma.user.findUnique({
    where: { user_id: credentials.user_id },
    include: { customer: true },
  });
  if (!user) throw new AuthServiceError(401, INVALID_CREDENTIALS_MESSAGE);

  const sessionPolicy = getSessionPolicy(user.role);
  const token = jwt.sign(
    { user_id: user.user_id, role: user.role },
    getJwtSecret(),
    { expiresIn: sessionPolicy.absoluteExpiresIn },
  );
  const decodedToken = jwt.decode(token);
  const tokenExpMs =
    decodedToken && typeof decodedToken.exp === "number"
      ? decodedToken.exp * 1000
      : Date.now() + sessionPolicy.idleMs;

  return {
    token,
    expiresAt: new Date(tokenExpMs),
    expiresIn: sessionPolicy.absoluteExpiresIn,
    user,
  };
}

async function getUserProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    include: { customer: true },
  });
  if (!user) throw new AuthServiceError(404, "User tidak ditemukan");

  if (!user.customer) return { user, nextReward: null };
  const nextReward = await getNextReward(user.customer.available_point ?? 0);
  return { user, nextReward };
}

async function changeUserPassword(userId, currentPassword, newPassword) {
  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    select: { user_id: true, password_hash: true },
  });
  if (!user) throw new AuthServiceError(404, "User tidak ditemukan");
  if (!hasUsablePassword(user)) {
    throw new AuthServiceError(409, "Akun belum memiliki password aktif");
  }

  const validPassword = await bcrypt.compare(
    currentPassword,
    user.password_hash,
  );
  if (!validPassword) throw new AuthServiceError(401, "Password lama salah");

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.user.update({
    where: { user_id: user.user_id },
    data: { password_hash: passwordHash },
  });
}

module.exports = {
  AuthServiceError,
  registerUser,
  sendUserReferenceCode,
  verifyUserPhone,
  authenticateUser,
  getUserProfile,
  changeUserPassword,
};
