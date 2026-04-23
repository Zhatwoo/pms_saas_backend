CREATE TRIGGER restrict_notification_update
BEFORE UPDATE ON notifications
FOR EACH ROW
EXECUTE FUNCTION prevent_notification_edit();