// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Mengimpor middleware autentikasi dan controller auth
const auth = require('../middleware/auth');
const { authIpLimiter, loginAccountLimiter } = require('../lib/rateLimit');
const {
  register,
  login,
  logout,
  logoutAllSessions,
  profile,
  validateActivationToken,
  activateAccount,
  changePassword,
} = require("../controllers/authController");

// ===================== REGISTER =====================
// Endpoint untuk meminta tautan aktivasi akun
router.post('/register', authIpLimiter, register);

// ===================== LOGIN =====================
// Dibatasi dua lapis: batas per IP menahan satu sumber yang membombardir,
// batas per nomor menahan serangan yang disebar lewat banyak IP ke satu akun.
router.post('/login', authIpLimiter, loginAccountLimiter, login);

// ===================== LOGOUT =====================
// Mencabut sesi di server, bukan sekadar menghapus token di browser
router.post('/logout', auth, logout);
router.post('/logout-all', auth, logoutAllSessions);

// ===================== ACCOUNT ACTIVATION =====================
// Validasi link aktivasi dan pembuatan password pertama customer
router.get('/activate', authIpLimiter, validateActivationToken);
router.post('/activate', authIpLimiter, activateAccount);

// ===================== PROFILE =====================
// Endpoint untuk mengambil data profil user (harus login)
router.get('/profile', auth, profile);

// ===================== CHANGE PASSWORD =====================
// Endpoint untuk mengganti password user yang sedang login
router.post('/change-password', auth, authIpLimiter, changePassword);

// Mengekspor router agar bisa digunakan di file utama (app.js/server.js)
module.exports = router;
