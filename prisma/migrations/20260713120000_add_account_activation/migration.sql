ALTER TABLE "User"
ADD COLUMN "activation_status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "activated_at" TIMESTAMP(3);

CREATE TABLE "AccountActivationToken" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'activation',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountActivationToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountActivationToken_token_hash_key" ON "AccountActivationToken"("token_hash");
CREATE INDEX "AccountActivationToken_user_id_idx" ON "AccountActivationToken"("user_id");
CREATE INDEX "AccountActivationToken_expires_at_idx" ON "AccountActivationToken"("expires_at");
CREATE INDEX "AccountActivationToken_purpose_idx" ON "AccountActivationToken"("purpose");

ALTER TABLE "AccountActivationToken"
ADD CONSTRAINT "AccountActivationToken_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "User"
SET "activation_status" = CASE
  WHEN "role" = 'customer' AND "password_hash" = '' THEN 'pending_activation'
  ELSE 'active'
END,
"activated_at" = CASE
  WHEN "password_hash" <> '' THEN "updated_at"
  ELSE NULL
END;
