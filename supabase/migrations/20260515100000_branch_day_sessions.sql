-- Mirrors prisma/migrations/20260515100000_branch_day_sessions/migration.sql

CREATE TABLE IF NOT EXISTS "branch_day_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "session_date" DATE NOT NULL,
    "starting_balance" DECIMAL(12,2) NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by_user_id" UUID,
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_day_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "branch_day_sessions_branch_session_date_key" ON "branch_day_sessions"("branch_id", "session_date");

CREATE INDEX IF NOT EXISTS "idx_branch_day_sessions_branch_date" ON "branch_day_sessions"("branch_id", "session_date" DESC);

ALTER TABLE "branch_day_sessions" DROP CONSTRAINT IF EXISTS "branch_day_sessions_branch_id_fkey";
ALTER TABLE "branch_day_sessions" ADD CONSTRAINT "branch_day_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "branch_day_sessions" DROP CONSTRAINT IF EXISTS "branch_day_sessions_started_by_user_id_fkey";
ALTER TABLE "branch_day_sessions" ADD CONSTRAINT "branch_day_sessions_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "branch_day_sessions" DROP CONSTRAINT IF EXISTS "branch_day_sessions_closed_by_user_id_fkey";
ALTER TABLE "branch_day_sessions" ADD CONSTRAINT "branch_day_sessions_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
