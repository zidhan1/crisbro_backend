const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const {
  listCustomers,
  getCustomer,
  getCustomerByUser,
  updateCustomer,
  getMyCustomer,
  updateMyCustomer,
} = require("../controllers/customer.controller");

const adminOrMarketing = requireRole("admin", "marketing");
const customerOnly = requireRole("customer");

router.use(auth);

router.get("/me", customerOnly, getMyCustomer);
router.patch("/me", customerOnly, updateMyCustomer);

router.get("/", adminOrMarketing, listCustomers);
router.get("/user/:user_id", adminOrMarketing, getCustomerByUser);
router.get("/:customer_id", adminOrMarketing, getCustomer);
router.patch("/:customer_id", adminOrMarketing, updateCustomer);

module.exports = router;
