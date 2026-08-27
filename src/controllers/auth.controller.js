const {
  respondWithServerError,
  badRequest,
  successRequest,
} = require("../utils/responseReuest");
const { setSessionCookie, clearSessionCookie } = require("../lib/sessionCookie");
const {
  registerSchemaValidation,
} = require("../validation/auth/auth-validation");
const {
  AuthServiceError,
  registerUser,
  sendUserOtp,
  verifyUserOtp,
  authenticateUser,
  getUserProfile,
  changeUserPassword,
} = require("../services/auth.service");

function serializeAuthUser(user) {
  if (!user) return user;

  const { password_hash, ...safeUser } = user;
  if (safeUser.email === null) delete safeUser.email;
  if (safeUser.phone_number === null) delete safeUser.phone_number;

  if (safeUser.customer) {
    safeUser.customer = {
      ...safeUser.customer,
      balance: Number(safeUser.customer.balance ?? 0),
    };
  }

  return safeUser;
}

function handleAuthError(res, error, context) {
  if (error instanceof AuthServiceError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      ...(error.details ? { errors: error.details } : {}),
    });
  }

  if (error.code === "JWT_SECRET_MISSING") {
    return res.status(500).json({
      message: "Authentication configuration error",
    });
  }

  return respondWithServerError(res, error, context);
}

async function register(req, res) {
  const validation = registerSchemaValidation.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      errors: validation.error.flatten().fieldErrors,
    });
  }

  try {
    const result = await registerUser(validation.data);
    return res.status(201).json({
      success: true,
      data: {
        user: serializeAuthUser(result.user),
        referral: result.referral,
      },
      message: "Berhasil membuat user dan mengirim otp",
    });
  } catch (error) {
    return handleAuthError(res, error, "Registrasi user gagal");
  }
}

async function sendOnlyOtpCode(req, res) {
  try {
    await sendUserOtp(req.user?.user_id);
    return successRequest({ res, code: 200, message: "Berhasil mengirim otp" });
  } catch (error) {
    return handleAuthError(res, error, "Pengiriman OTP gagal");
  }
}

async function otpCodeValidation(req, res) {
  try {
    const user = await verifyUserOtp(req.user?.user_id, req.body?.otp_code);
    return successRequest({
      res,
      code: 200,
      data: serializeAuthUser(user),
      message: "Berhasil melakukan validasi phone",
    });
  } catch (error) {
    return handleAuthError(res, error, "Validasi OTP gagal");
  }
}

async function login(req, res) {
  try {
    const result = await authenticateUser(req.body ?? {});
    setSessionCookie(res, result.token, result.expiresAt);

    return res.json({
      expiresIn: result.expiresIn,
      user: serializeAuthUser(result.user),
    });
  } catch (error) {
    return handleAuthError(res, error, "Login gagal");
  }
}

async function profile(req, res) {
  try {
    const result = await getUserProfile(req.user?.user_id);
    const user = serializeAuthUser(result.user);

    if (user.customer && result.nextReward) {
      user.customer = { ...user.customer, ...result.nextReward };
    }

    return res.json(user);
  } catch (error) {
    return handleAuthError(res, error, "Pengambilan profil gagal");
  }
}

async function changePassword(req, res) {
  const currentPassword =
    typeof req.body?.current_password === "string"
      ? req.body.current_password
      : "";
  const newPassword =
    typeof req.body?.new_password === "string" ? req.body.new_password : "";

  if (!currentPassword || newPassword.trim().length < 8) {
    return badRequest({
      res,
      code: 400,
      error: "Password lama wajib diisi dan password baru minimal 8 karakter",
    });
  }

  if (currentPassword === newPassword) {
    return badRequest({
      res,
      code: 400,
      error: "Password baru harus berbeda dari password lama",
    });
  }

  try {
    await changeUserPassword(
      req.user?.user_id,
      currentPassword,
      newPassword,
    );
    clearSessionCookie(res);
    return res.json({
      message: "Password berhasil diganti. Silakan login ulang.",
    });
  } catch (error) {
    return handleAuthError(res, error, "Perubahan password gagal");
  }
}

function logout(req, res) {
  clearSessionCookie(res);
  return res.json({ message: "Berhasil keluar" });
}

function logoutAllSessions(req, res) {
  // Schema aktif menggunakan JWT stateless dan tidak memiliki model Session.
  clearSessionCookie(res);
  return res.json({
    message: "Berhasil keluar dari sesi saat ini",
    revoked_sessions: 0,
  });
}

module.exports = {
  register,
  sendOnlyOtpCode,
  otpCodeValidation,
  login,
  logout,
  logoutAllSessions,
  profile,
  changePassword,
};
