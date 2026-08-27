-- Restore the persistent rate-limit store used by src/lib/rateLimit.js.
-- IF NOT EXISTS keeps this migration safe for databases that received the
-- original table before its migration directory was removed locally.
CREATE TABLE IF NOT EXISTS "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "RateLimitCounter_expires_at_idx"
ON "RateLimitCounter"("expires_at");

ALTER TABLE "RateLimitCounter" ENABLE ROW LEVEL SECURITY;
