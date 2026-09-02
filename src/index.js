// Load environment variables (.env)
require("dotenv").config({ quiet: true });

function logFatalError(type, error) {
  const value = error instanceof Error ? error : new Error(String(error));
  console.error(`[${new Date().toISOString()}] ${type}:`, value);
}

// Log errors that escape Express. Exit after an uncaught error because the
// process may be left in an inconsistent state; nodemon/platform runtime will
// restart it and the complete stack remains visible in the terminal/logs.
process.on("unhandledRejection", (reason) => {
  logFatalError("Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logFatalError("Uncaught exception", error);
  process.exit(1);
});

// Core dependencies
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { openApiSpec, renderSwaggerHtml } = require("./docs/swagger");
const { globalLimiter } = require("./lib/rateLimit");
const { createCorsPolicy } = require("./lib/corsPolicy");
const { setPrivateNoStoreHeaders } = require("./lib/responseCache");
const { respondWithServerError } = require("./lib/serverError");

// Middleware
const requireDocsAccess = require("./middleware/docsAccess");
const docsContentSecurityPolicy = require("./middleware/docsCsp");
const csrfProtection = require("./middleware/csrfProtection");

// Routes (modular API)
const allRouter = require("./routes/routes");

const app = express();

app.set("trust proxy", 1);

// Content Security Policy (CSP)
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);

// Cors Configuration
const corsPolicy = createCorsPolicy();
app.use(corsPolicy.guard);
app.use(cors(corsPolicy.corsOptions));

// Limit Request Body
app.use(express.json({ limit: "100kb" }));

// CSRF Protection
app.use(csrfProtection);

// L-5: deny-by-default. Semua respons API private/no-store kecuali route GET
// publik yang secara eksplisit memasang shared CDN cache sesaat sebelum send.
app.use(setPrivateNoStoreHeaders);

// API Limiter
app.use(globalLimiter);
// M-13: Melindungi akses Swagger UI dan OpenAPI dengan pembatasan akses agar tidak terekspos di lingkungan production.
app.get("/api/docs/openapi.json", requireDocsAccess, (req, res) =>
  res.set("Cache-Control", "no-store").json(openApiSpec),
);
app.get(
  ["/api/docs", "/api/docs/"],
  docsContentSecurityPolicy,
  requireDocsAccess,
  (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderSwaggerHtml(res.locals.cspNonce));
  },
);

// Manage All Routues
app.use("/api", allRouter);

// Health Check
app.get("/", (req, res) => {
  res.json({ message: "API Running" });
});

// Central error handler. Do not log request bodies or authorization headers:
// they can contain passwords, tokens, and customer data.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return respondWithServerError(res, error, `${req.method} ${req.originalUrl}`);
});

// Start Server
if (require.main === module) {
  const port = process.env.PORT || 5002;

  const server = app.listen(port, (error) => {
    // Express 5 forwards listen errors to this callback instead of throwing
    // them. Ignoring the argument makes nodemon report a misleading
    // "clean exit" when, for example, the port is already occupied.
    if (error) {
      console.error(
        `[${new Date().toISOString()}] Server gagal berjalan di port ${port}:`,
        error,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`Server running on port ${port}`);
  });

  server.on("close", () => {
    console.warn(
      `[${new Date().toISOString()}] HTTP server ditutup; proses akan berhenti bila tidak ada pekerjaan lain.`,
    );
  });
}

module.exports = app;
