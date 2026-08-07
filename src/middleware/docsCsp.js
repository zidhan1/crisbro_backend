const crypto = require('crypto');
const { contentSecurityPolicy } = require('helmet');

// L-2: Menerapkan CSP khusus pada Swagger UI dengan nonce untuk menjaga keamanan script sekaligus tetap mendukung kebutuhan fungsional dokumentasi API.
const SWAGGER_CDN_ORIGIN = 'https://cdn.jsdelivr.net';

module.exports = function docsContentSecurityPolicy(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  return contentSecurityPolicy({
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", `'nonce-${nonce}'`, SWAGGER_CDN_ORIGIN],
      styleSrc: ["'self'", SWAGGER_CDN_ORIGIN, "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', SWAGGER_CDN_ORIGIN],
      fontSrc: ["'self'", SWAGGER_CDN_ORIGIN],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
  })(req, res, next);
};
