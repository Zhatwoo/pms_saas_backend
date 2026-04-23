-- Create Customers table and relate pawned items to customers

CREATE TABLE public.customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  address text NOT NULL,
  barangay text,
  city text,
  province text,
  contact_number text,
  email text,
  id_presented text,
  branch_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT customers_pkey PRIMARY KEY (id),
  CONSTRAINT customers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id)
);

ALTER TABLE public.pawned_items
  ADD COLUMN customer_id uuid;

ALTER TABLE public.pawned_items
  ADD CONSTRAINT pawned_items_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);
