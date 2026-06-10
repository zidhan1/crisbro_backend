const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const { register, login, profile } = require("../controllers/authController");

// ===================== REGISTER =====================
router.post('/register', register);

// ===================== LOGIN =====================
router.post('/login', login);

// ===================== PROFILE =====================
router.get('/profile', auth, profile);

module.exports = router;