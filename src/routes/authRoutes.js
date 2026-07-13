// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Mengimpor middleware autentikasi dan controller auth
const auth = require('../middleware/auth');
const {
  register,
  login,
  profile,
  validateActivationToken,
  activateAccount,
  changePassword,
} = require("../controllers/authController");

// ===================== REGISTER =====================
// Endpoint untuk registrasi user baru
router.post('/register', register);

// ===================== LOGIN =====================
// Endpoint untuk login user
router.post('/login', login);

// ===================== ACCOUNT ACTIVATION =====================
// Validasi link aktivasi dan pembuatan password pertama customer
router.get('/activate', validateActivationToken);
router.post('/activate', activateAccount);

// ===================== PROFILE =====================
// Endpoint untuk mengambil data profil user (harus login)
router.get('/profile', auth, profile);

// ===================== CHANGE PASSWORD =====================
// Endpoint untuk mengganti password user yang sedang login
router.post('/change-password', auth, changePassword);

// Mengekspor router agar bisa digunakan di file utama (app.js/server.js)
module.exports = router;
