// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Middleware autentikasi (JWT)
const auth = require('../middleware/auth');

// Mengimpor controller untuk fitur redeem reward
const {
  redeemReward,
  getMyRedemptions,
} = require('../controllers/redemptionController');

// ===================== REDEEM REWARD =====================

// Endpoint untuk menukar reward berdasarkan rewardId (harus login)
router.post('/:rewardId', auth, redeemReward);

// ===================== RIWAYAT REDEEM =====================

// Endpoint untuk melihat riwayat reward yang pernah ditukar user
router.get('/my', auth, getMyRedemptions);

module.exports = router;
