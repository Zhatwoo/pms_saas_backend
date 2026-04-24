-- Backfill CUSTOMER_EDIT_REQUESTED activity logs that are missing field, mode, and actorLabel.
-- The notes template is: "Request to review <field_label> for <customer_name>. Please verify..."
-- We parse the field from the notes text and set mode = 'specific' when a known field is detected.

DO $$
DECLARE
  log_row RECORD;
  d jsonb;
  notes_text text;
  detected_field text;
  detected_mode text;
  actor_name text;
  actor_label text;
  updated_d jsonb;
BEGIN
  FOR log_row IN
    SELECT id, details, user_id
    FROM activity_logs
    WHERE action = 'CUSTOMER_EDIT_REQUESTED'
  LOOP
    -- Parse existing details JSON
    BEGIN
      d := log_row.details::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;

    -- Skip if already has field and mode set
    IF (d ? 'field') AND (d ? 'mode') THEN
      CONTINUE;
    END IF;

    notes_text := lower(coalesce(d->>'notes', ''));

    -- Detect field from notes template text (strict match only — must be unedited template)
    detected_field := NULL;
    detected_mode  := 'freeform';

    IF notes_text ~ '^request to review .+ for .+\. please verify and update the customer record if needed\.?$' THEN
      IF notes_text LIKE 'request to review full name%' THEN
        detected_field := 'full_name';
        detected_mode  := 'specific';
      ELSIF notes_text LIKE 'request to review contact number%' THEN
        detected_field := 'contact_number';
        detected_mode  := 'specific';
      ELSIF notes_text LIKE 'request to review address%' THEN
        detected_field := 'address';
        detected_mode  := 'specific';
      ELSIF notes_text LIKE 'request to review email%' THEN
        detected_field := 'email';
        detected_mode  := 'specific';
      ELSIF notes_text LIKE 'request to review id presented%' THEN
        detected_field := 'id_presented';
        detected_mode  := 'specific';
      END IF;
    END IF;

    -- Build actorLabel if missing
    IF NOT (d ? 'actorLabel') THEN
      SELECT coalesce(full_name, email, 'Unknown')
      INTO actor_name
      FROM users
      WHERE id = log_row.user_id
      LIMIT 1;

      actor_label := actor_name || ' (Employee)';
    ELSE
      actor_label := d->>'actorLabel';
    END IF;

    -- Merge new fields into existing details
    updated_d := d
      || jsonb_build_object('mode', detected_mode)
      || jsonb_build_object('actorLabel', actor_label);

    IF detected_field IS NOT NULL THEN
      updated_d := updated_d || jsonb_build_object('field', detected_field);
    END IF;

    UPDATE activity_logs
    SET details = updated_d::text
    WHERE id = log_row.id;

  END LOOP;
END $$;
