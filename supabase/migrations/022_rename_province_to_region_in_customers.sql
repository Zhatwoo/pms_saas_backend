-- Rename province → region in customers table
-- Region is the top-level Philippine address division (e.g. NCR, Region IV-A)
-- and is what the PSGC address dropdowns now store.

ALTER TABLE public.customers
  RENAME COLUMN province TO region;
