// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Middleware autentikasi (JWT)
const auth = require('../middleware/auth');

// Mengimpor controller untuk fitur redeem reward
const {
  redeemReward,
  redeemMenuItem,
  getMyRedemptions,
} = require('../controllers/redemptionController');

// ===================== RIWAYAT REDEEM =====================

// Endpoint untuk melihat riwayat reward yang pernah ditukar user
router.get('/my', auth, getMyRedemptions);

// ===================== REDEEM MENU =====================

// Endpoint untuk menukar item menu redeem berdasarkan RedeemMenuItem.id
router.post('/menu/:redeemMenuItemId', auth, redeemMenuItem);

// ===================== REDEEM REWARD =====================

// Endpoint untuk menukar reward berdasarkan rewardId (harus login)
router.post('/:rewardId', auth, redeemReward);

module.exports = router;
