const { safeStringEqual } = require('../lib/safeCompare');

// Membatasi akses Swagger UI dan OpenAPI di production serta mewajibkan autentikasi saat diaktifkan untuk mencegah paparan dokumentasi API.
function isDocsEnabled() {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.API_DOCS_ENABLED === 'true';
}

function parseBasicAuth(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;

  let decoded;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString(
      'utf8',
    );
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return null;

  return {
    user: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function requestBasicAuth(res) {
  return res
    .set('WWW-Authenticate', 'Basic realm="Crisbar API Docs"')
    .status(401)
    .json({ message: 'Unauthorized' });
}

// Middleware akses dokumentasi API (/api/docs, /api/docs/openapi.json).
module.exports = function requireDocsAccess(req, res, next) {
  if (!isDocsEnabled()) {
    // 404, bukan 403, agar keberadaan endpoint docs tidak dikonfirmasi ke publik.
    return res.status(404).end();
  }

  const docsUser = process.env.API_DOCS_USER;
  const docsPassword = process.env.API_DOCS_PASSWORD;

  if (!docsUser || !docsPassword) {
    if (process.env.NODE_ENV === 'production') {
      // Docs diaktifkan tapi kredensial belum diset: gagal tertutup, jangan
      // pernah membuka docs tanpa proteksi di production.
      return res.status(503).json({
        message: 'API_DOCS_USER/API_DOCS_PASSWORD belum dikonfigurasi',
      });
    }

    return next();
  }

  const credentials = parseBasicAuth(req.get('authorization'));

  if (
    credentials &&
    safeStringEqual(credentials.user, docsUser) &&
    safeStringEqual(credentials.password, docsPassword)
  ) {
    return next();
  }

  return requestBasicAuth(res);
};
