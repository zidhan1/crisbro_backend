const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { redeemReward, getMyRedemptions } = require('../controllers/redemptionController');

router.post('/:rewardId', auth, redeemReward);
router.get('/my', auth, getMyRedemptions);

module.exports = router;