DELETE FROM public.notifications
WHERE notification_type = 'USER_BRANCH_TRANSFER'
  AND user_id IS NULL;
