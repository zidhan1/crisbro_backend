const DEFAULT_PRODUCTION_ORIGINS = Object.freeze([
  "https://crisbro-frontend.vercel.app",
]);

function normalizeConfiguredOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const parsed = new URL(value.trim());
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeRequestOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function createCorsPolicy({
  nodeEnv = process.env.NODE_ENV,
  frontendUrl = process.env.FRONTEND_URL,
  corsOrigins = process.env.CORS_ORIGINS,
} = {}) {
  const configuredOrigins = [
    ...DEFAULT_PRODUCTION_ORIGINS,
    frontendUrl,
    "http://localhost:5173",
    "http://localhost:5002",
    ...String(corsOrigins || "").split(","),
  ];
  const allowedOrigins = new Set(
    configuredOrigins.map(normalizeConfiguredOrigin).filter(Boolean),
  );
  const isProduction = nodeEnv === "production";

  function isAllowedOrigin(origin) {
    const normalized = normalizeRequestOrigin(origin);
    if (!normalized) return false;
    if (allowedOrigins.has(normalized)) return true;

    if (isProduction) return false;
    const hostname = new URL(normalized).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  }

  function guard(req, res, next) {
    const origin = req.get("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return res
        .status(403)
        .json({ message: "Origin tidak diizinkan oleh kebijakan CORS" });
    }
    return next();
  }

  return {
    allowedOrigins,
    isAllowedOrigin,
    guard,
    corsOptions: { origin: true, credentials: true },
  };
}

module.exports = {
  DEFAULT_PRODUCTION_ORIGINS,
  normalizeConfiguredOrigin,
  createCorsPolicy,
};
