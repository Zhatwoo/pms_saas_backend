-- Create Notifications Table
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    subtitle TEXT,
    category TEXT CHECK (category IN ('Transactions', 'Alerts', 'Requests')),
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Notifications Policies

-- 1. Users can view notifications specifically for them, for their branch, or global ones (branch_id IS NULL)
CREATE POLICY "Users can view relevant notifications" ON public.notifications
    FOR SELECT
    USING (
        auth.uid() IN (SELECT auth_id FROM public.users) -- Must be a valid user
        AND (
            user_id IN (SELECT id FROM public.users WHERE auth_id = auth.uid()) -- Personal
            OR branch_id IN (SELECT branch_id FROM public.users WHERE auth_id = auth.uid()) -- Branch-wide
            OR branch_id IS NULL -- Global
            OR (SELECT role FROM public.users WHERE auth_id = auth.uid()) = 'super_admin' -- SuperAdmin sees all
        )
    );

-- 2. Users can mark their own or branch notifications as read
CREATE POLICY "Users can update their relevant notifications" ON public.notifications
    FOR UPDATE
    USING (
        auth.uid() IN (SELECT auth_id FROM public.users)
        AND (
            user_id IN (SELECT id FROM public.users WHERE auth_id = auth.uid())
            OR branch_id IN (SELECT branch_id FROM public.users WHERE auth_id = auth.uid())
            OR (SELECT role FROM public.users WHERE auth_id = auth.uid()) = 'super_admin'
        )
    )
    WITH CHECK (is_read = true); -- Only allowed to change is_read

-- Indexing for performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_branch_id ON public.notifications(branch_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at);
