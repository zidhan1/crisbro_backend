const express = require("express");
const { auth } = require("../middleware/authMiddleware");
const { getMyPointHistory } = require("../controllers/pointController");

const router = express.Router();

router.get("/history", auth, getMyPointHistory);

module.exports = router;
