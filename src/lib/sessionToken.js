const crypto = require('node:crypto');

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

module.exports = { hashSessionToken };
