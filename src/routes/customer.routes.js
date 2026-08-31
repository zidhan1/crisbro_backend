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

router.get("/customers/me", customerOnly, getMyCustomer);
router.patch("/customers/me", customerOnly, updateMyCustomer);

router.get("/customers", adminOrMarketing, listCustomers);
router.get(
  "/customers/user/:user_id",
  adminOrMarketing,
  getCustomerByUser,
);
router.get(
  "/customers/:customer_id",
  adminOrMarketing,
  getCustomer,
);
router.patch(
  "/customers/:customer_id",
  adminOrMarketing,
  updateCustomer,
);

module.exports = router;
