const express = require("express");
const router = express.Router(); 
const auth = require("../middleware/auth"); 

// Mengimpor controller untuk mengambil data poin customer
const {
  getCustomerPoints,
} = require("../controllers/customerController");

// Endpoint untuk mendapatkan data poin customer (hanya bisa diakses user login)
router.get("/customer-points", auth, getCustomerPoints);

module.exports = router;
