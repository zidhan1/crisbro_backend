const express = require("express");
const {
  receiveQontakMessageInteraction,
} = require("../controllers/qontak.controller");
const router = express.Router();

router.post("/733f8d9cc06104f3", receiveQontakMessageInteraction);

module.exports = router;
