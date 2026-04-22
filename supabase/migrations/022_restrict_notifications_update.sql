CREATE OR REPLACE FUNCTION prevent_notification_edit()
RETURNS trigger AS $$
BEGIN
  -- Allow only is_read to change
  IF NEW.is_read IS DISTINCT FROM OLD.is_read THEN
    -- ok
  END IF;

  -- Block changes to other fields
  IF NEW.message IS DISTINCT FROM OLD.message
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Only is_read can be updated';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;