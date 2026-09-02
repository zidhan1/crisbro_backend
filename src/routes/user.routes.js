const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const { createUser, updateUser } = require("../controllers/user.controller");

const adminOnly = requireRole("admin");

router.use(auth);

router.post("/", adminOnly, createUser);
router.patch("/:user_id", adminOnly, updateUser);

module.exports = router;
