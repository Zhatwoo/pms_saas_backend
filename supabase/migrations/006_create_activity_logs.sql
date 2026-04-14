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
