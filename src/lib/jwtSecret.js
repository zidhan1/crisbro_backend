function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    const error = new Error('JWT_SECRET is not configured');
    error.code = 'JWT_SECRET_MISSING';
    throw error;
  }

  return secret;
}

module.exports = getJwtSecret;
