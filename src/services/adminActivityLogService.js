const prisma = require('../lib/prisma');

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'token_hash',
  'authorization',
]);

function sanitizeValue(value) {
  if (value === null || value === undefined) return value;

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'object' && typeof value.toJSON === 'function') {
    return sanitizeValue(value.toJSON());
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeValue(item),
      ]),
    );
  }

  return value;
}

function toAuditJson(value) {
  if (value === undefined) return undefined;
  return sanitizeValue(value);
}

function getRequestIp(req) {
  const forwardedFor = req.get?.('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

async function recordAdminActivity({
  req,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  metadata = null,
}) {
  try {
    await prisma.adminActivityLog.create({
      data: {
        actor_user_id: req?.user?.id ?? null,
        actor_role: req?.user?.role ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        before: toAuditJson(before),
        after: toAuditJson(after),
        metadata: toAuditJson(metadata),
        ip_address: getRequestIp(req),
        user_agent: req?.get?.('user-agent') ?? null,
      },
    });
  } catch (error) {
    console.warn('[admin-activity-log] failed to record activity:', error.message);
  }
}

module.exports = {
  recordAdminActivity,
  toAuditJson,
};
