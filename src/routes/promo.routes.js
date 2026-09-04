const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const { createPromoController } = require("../controllers/promo.controller");

router.post("/", auth, requireRole("admin", "marketing"), createPromoController);

module.exports = router;
