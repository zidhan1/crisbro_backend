CREATE TABLE "AdminActivityLog" (
    "id" SERIAL NOT NULL,
    "actor_user_id" INTEGER,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActivityLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminActivityLog_actor_user_id_idx" ON "AdminActivityLog"("actor_user_id");
CREATE INDEX "AdminActivityLog_action_idx" ON "AdminActivityLog"("action");
CREATE INDEX "AdminActivityLog_entity_type_entity_id_idx" ON "AdminActivityLog"("entity_type", "entity_id");
CREATE INDEX "AdminActivityLog_created_at_idx" ON "AdminActivityLog"("created_at");

ALTER TABLE "AdminActivityLog"
ADD CONSTRAINT "AdminActivityLog_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
