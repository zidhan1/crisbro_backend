const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'crisbar_session';

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Cookie dengan encoding rusak bukan kredensial yang valid.
    }
    return cookies;
  }, {});
}

function getSessionCookie(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || null;
}

function cookieOptions(expiresAt) {
  const defaultSameSite = process.env.NODE_ENV === 'production' ? 'none' : 'strict';
  const configured = String(
    process.env.SESSION_COOKIE_SAME_SITE || defaultSameSite,
  ).toLowerCase();
  const sameSite = ['strict', 'lax', 'none'].includes(configured)
    ? configured
    : defaultSameSite;
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || sameSite === 'none',
    sameSite,
    path: '/api',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(expiresAt));
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

module.exports = {
  getSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  cookieOptions,
};
