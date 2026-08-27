const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/authMiddleware");
const { getCustomerPoints } = require("../controllers/customerController");
const {
  getCustomerPointsByUserId,
} = require("../services/domain/customerService");
const { privateCache } = require("../services/shared/cacheService");
const { respondWithServerError } = require("../lib/serverError");

// Endpoint untuk mendapatkan data poin customer (hanya bisa diakses user login)
router.get("/customer-points", auth, getCustomerPoints);

// GET /api/my-points — ambil poin customer yang login
router.get(
  "/my-points",
  auth,
  privateCache("USER_POINTS"),
  async (req, res) => {
    try {
      const points = await getCustomerPointsByUserId(req.user.id);
      res.json(points);
    } catch (error) {
      if (error.message === "Customer tidak ditemukan") {
        return res.status(404).json({ message: error.message });
      }
      respondWithServerError(res, error, "customerRoutes");
    }
  },
);

module.exports = router;
