const express = require("express");
const router = express.Router();
const {
  generateSubBrand,
  listSubBrands,
} = require("../controllers/subBrand.controller");
const { auth, requireRole } = require("../middleware/authMiddleware");

router.get("/", listSubBrands);
router.post("/generate", auth, requireRole("admin"), generateSubBrand);

module.exports = router;
