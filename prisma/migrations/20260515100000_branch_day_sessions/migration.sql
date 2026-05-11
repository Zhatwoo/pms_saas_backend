-- Per-branch Manila calendar day session: starting balance + end-day closure gate.

CREATE TABLE "branch_day_sessions" (
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

CREATE UNIQUE INDEX "branch_day_sessions_branch_session_date_key" ON "branch_day_sessions"("branch_id", "session_date");

CREATE INDEX "idx_branch_day_sessions_branch_date" ON "branch_day_sessions"("branch_id", "session_date" DESC);

ALTER TABLE "branch_day_sessions" ADD CONSTRAINT "branch_day_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "branch_day_sessions" ADD CONSTRAINT "branch_day_sessions_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "branch_day_sessions" ADD CONSTRAINT "branch_day_sessions_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
