// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Mengimpor middleware autentikasi dan controller auth
const auth = require('../middleware/auth');
const { register, login, profile } = require("../controllers/authController");

// ===================== REGISTER =====================
// Endpoint untuk registrasi user baru
router.post('/register', register);

// ===================== LOGIN =====================
// Endpoint untuk login user
router.post('/login', login);

// ===================== PROFILE =====================
// Endpoint untuk mengambil data profil user (harus login)
router.get('/profile', auth, profile);

// Mengekspor router agar bisa digunakan di file utama (app.js/server.js)
module.exports = router;