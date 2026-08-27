const express = require("express");
const router = express.Router();

router.post("/733f8d9cc06104f3", async (req, res) => {
  const { verify_info } = req.body;
  const payload = req.body;

  if (!verify_info) {
    return res.status(400).json({
      success: false,
    });
  }

  console.log(payload);

  return res.status(200).json({
    success: true,
  });
});

module.exports = router;
