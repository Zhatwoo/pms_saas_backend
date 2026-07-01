-- Migration: Add buyback_proof column and storage bucket
-- Description: Adds buyback_proof column to transactions table and creates Supabase storage bucket for buyback proof images

-- Add buyback_proof column to transactions table
ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS buyback_proof TEXT NULL;

-- Create Supabase storage bucket for buyback proofs (only if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'buyback-proofs'
  ) THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('buyback-proofs', 'buyback-proofs', true);
  END IF;
END $$;

-- Create insert policy for authenticated users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'buyback_proofs_insert'
  ) THEN
    CREATE POLICY "buyback_proofs_insert"
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'buyback-proofs');
  END IF;
END $$;

-- Create update policy for authenticated users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'buyback_proofs_update'
  ) THEN
    CREATE POLICY "buyback_proofs_update"
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (bucket_id = 'buyback-proofs')
      WITH CHECK (bucket_id = 'buyback-proofs');
  END IF;
END $$;
