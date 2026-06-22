-- Drop global unique on device_fingerprint; allow multiple employees per shared PC.
ALTER TABLE "public"."authorized_devices"
  DROP CONSTRAINT IF EXISTS "authorized_devices_device_fingerprint_key";

CREATE UNIQUE INDEX IF NOT EXISTS "uq_authorized_devices_employee_fingerprint"
  ON "public"."authorized_devices" ("employee_id", "device_fingerprint");

CREATE INDEX IF NOT EXISTS "authorized_devices_device_fingerprint_idx"
  ON "public"."authorized_devices" ("device_fingerprint");
