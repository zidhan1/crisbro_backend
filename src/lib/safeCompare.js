const crypto = require('crypto');

// Perbandingan string dengan waktu konstan agar tahan terhadap timing attack
// saat memvalidasi secret (cron secret, kredensial docs, dsb).
function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

module.exports = { safeStringEqual };
