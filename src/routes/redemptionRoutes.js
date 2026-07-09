// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Middleware autentikasi (JWT)
const auth = require('../middleware/auth');

// Mengimpor controller untuk fitur redeem
const {
  redeemReward,
  redeemMenuItem,
  getMyRedemptions,
} = require('../controllers/redemptionController');

// ===================== RIWAYAT REDEEM =====================

// Endpoint untuk melihat riwayat reward yang pernah ditukar user
router.get('/my', auth, getMyRedemptions);

// ===================== REDEEM MENU =====================

// Penukaran menu reward dilakukan melalui kasir/POS Runchise.
router.post('/menu/:redeemMenuItemId', auth, redeemMenuItem);

// ===================== REDEEM REWARD =====================

// Penukaran reward dilakukan melalui kasir/POS Runchise.
router.post('/:rewardId', auth, redeemReward);

module.exports = router;
