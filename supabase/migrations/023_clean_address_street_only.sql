-- Clean up the address column to store only the street/house number part.
-- Previously, address was stored as a concatenated string:
-- "street, barangay, city, region"
-- Now that barangay, city, and region are separate columns, strip them out.

UPDATE public.customers
SET address = TRIM(SPLIT_PART(address, ',', 1))
WHERE address LIKE '%,%';
