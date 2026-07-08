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

// ===================== RIWAYAT REDEEM =====================

// Endpoint untuk melihat riwayat reward yang pernah ditukar user
router.get('/my', auth, getMyRedemptions);

// ===================== REDEEM MENU =====================

// Penukaran menu reward dilakukan melalui kasir, bukan dari aplikasi customer.
router.post('/menu/:redeemMenuItemId', auth, (req, res) => {
  return res.status(410).json({
    message:
      'Penukaran menu reward dilakukan melalui kasir. Aplikasi customer hanya menampilkan estimasi penukaran.',
  });
});

// ===================== REDEEM REWARD =====================

// Endpoint untuk menukar reward berdasarkan rewardId (harus login)
router.post('/:rewardId', auth, redeemReward);

module.exports = router;
