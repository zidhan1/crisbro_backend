// Mengimpor Express untuk membuat router
const express = require("express");
const router = express.Router();

// Mengimpor middleware autentikasi dan controller auth
const { auth, requireValidPhone } = require("../middleware/authMiddleware");
const { authIpLimiter, loginAccountLimiter } = require("../lib/rateLimit");
const {
  register,
  login,
  logout,
  logoutAllSessions,
  profile,
  changePassword,
  sendOnlyOtpCode,
  otpCodeValidation,
} = require("../controllers/auth.controller");

// ===================== REGISTER =====================
router.post("/register", register);

// ===================== LOGIN =====================
router.post("/login", authIpLimiter, loginAccountLimiter, login);

// ==================== SEND OTP ====================
router.post("/send-otp", authIpLimiter, auth, sendOnlyOtpCode);

// ===================== VERIFY OTP ===================
router.post("/verify-otp", authIpLimiter, auth, otpCodeValidation);

// ===================== LOGOUT =====================
router.post("/logout", auth, logout);
router.post("/logout-all", auth, logoutAllSessions);

// ===================== PROFILE =====================
router.get("/profile", auth, requireValidPhone, profile);

// ===================== CHANGE PASSWORD =====================
router.post("/change-password", auth, authIpLimiter, changePassword);

module.exports = router;
