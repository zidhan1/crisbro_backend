const express = require("express");
const router = express.Router();

router.post("/733f8d9cc06104f3", async (req, res) => {
  const payload = req.body;

  console.log(payload);

  return res.status(200).json({
    success: true,
  });
});

module.exports = router;
