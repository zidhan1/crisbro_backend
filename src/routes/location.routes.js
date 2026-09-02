const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const {
  generateLocations,
  listLocations,
} = require("../controllers/location.controller");

// POST /api/locations/generate — synchronize locations from Runchise.
router.post("/generate", auth, requireRole("admin"), generateLocations);

// GET /api/locations

module.exports = router;
