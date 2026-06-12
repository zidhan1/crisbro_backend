const express = require("express");
const router = express.Router();

const {
  getCustomerPoints,
} = require("../controllers/customerController");

router.get("/customer-points", getCustomerPoints);

module.exports = router;