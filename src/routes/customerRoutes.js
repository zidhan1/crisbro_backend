const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

const {
  getCustomerPoints,
} = require("../controllers/customerController");

router.get("/customer-points", auth, getCustomerPoints);

module.exports = router;
