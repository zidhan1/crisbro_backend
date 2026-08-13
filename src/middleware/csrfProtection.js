const { getSessionCookie } = require('../lib/sessionCookie');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method) || !getSessionCookie(req)) return next();

  if (req.get('x-csrf-protection') !== '1') {
    return res.status(403).json({ message: 'Validasi CSRF gagal' });
  }

  return next();
};
