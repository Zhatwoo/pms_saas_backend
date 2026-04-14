-- Create activity_logs table
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Set up RLS
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated users (we will enforce branch/role rules in API or via specific policies)
CREATE POLICY "Users can view logs" ON public.activity_logs
    FOR SELECT USING (auth.role() = 'authenticated');

-- Allow insert by authenticated users
CREATE POLICY "Users can insert logs" ON public.activity_logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Optional: Super admin policy just in case
CREATE POLICY "Super admins can do anything on logs" ON public.activity_logs
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = auth.uid() AND role = 'super_admin'
        )
    );

-- ═══════════════════════════════════════════════════════════════
-- Auto-cleanup: delete activity logs older than 90 days
-- ═══════════════════════════════════════════════════════════════

-- Index on created_at for fast range-based deletes
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
    ON public.activity_logs (created_at);

-- Reusable cleanup function (deletes in batches to avoid long locks)
CREATE OR REPLACE FUNCTION public.cleanup_old_activity_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    rows_deleted INTEGER;
BEGIN
    LOOP
        DELETE FROM public.activity_logs
        WHERE id IN (
            SELECT id FROM public.activity_logs
            WHERE created_at < now() - INTERVAL '90 days'
            LIMIT 1000
        );
        GET DIAGNOSTICS rows_deleted = ROW_COUNT;
        EXIT WHEN rows_deleted = 0;
    END LOOP;
END;
$$;

-- Enable pg_cron (Supabase has this extension available)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily cleanup at 3:00 AM UTC
SELECT cron.schedule(
    'cleanup-activity-logs',      -- job name
    '0 3 * * *',                  -- cron expression: daily at 03:00 UTC
    $$SELECT public.cleanup_old_activity_logs()$$
);
