const crypto = require('crypto');
const prisma = require('../lib/prisma');

const ACTIVATION_TOKEN_TTL_HOURS = Number(
  process.env.ACTIVATION_TOKEN_TTL_HOURS || 24,
);

function hashActivationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getFrontendBaseUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    process.env.PUBLIC_APP_URL ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
}

function buildActivationUrl(token) {
  return `${getFrontendBaseUrl()}/activate?token=${encodeURIComponent(token)}`;
}

async function createAccountActivationToken(userId, purpose = 'activation') {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashActivationToken(token);
  const expiresAt = new Date(
    Date.now() + ACTIVATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
  );

  await prisma.accountActivationToken.create({
    data: {
      user_id: userId,
      token_hash: tokenHash,
      purpose,
      expires_at: expiresAt,
    },
  });

  return {
    token,
    expiresAt,
    activationUrl: buildActivationUrl(token),
  };
}

async function invalidatePendingActivationTokens(userId, purpose = 'activation') {
  await prisma.accountActivationToken.updateMany({
    where: {
      user_id: userId,
      purpose,
      used_at: null,
    },
    data: {
      used_at: new Date(),
    },
  });
}

module.exports = {
  ACTIVATION_TOKEN_TTL_HOURS,
  buildActivationUrl,
  createAccountActivationToken,
  hashActivationToken,
  invalidatePendingActivationTokens,
};
