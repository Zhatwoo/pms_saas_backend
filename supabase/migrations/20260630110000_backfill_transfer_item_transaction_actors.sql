update public.transactions t
set
  created_by_user_id = coalesce(
    case
      when t.branch_id = ti.target_branch_id then ti.received_by_user_id
      when t.branch_id = ti.source_branch_id then ti.requested_by_user_id
      else null
    end,
    ti.received_by_user_id,
    ti.requested_by_user_id
  ),
  updated_at = now()
from public.transfer_items ti
where t.purpose = 'Transfer Item'
  and t.created_by_user_id is null
  and t.related_sale_item_id = ti.sale_item_id
  and t.environment = ti.environment
  and coalesce(
    case
      when t.branch_id = ti.target_branch_id then ti.received_by_user_id
      when t.branch_id = ti.source_branch_id then ti.requested_by_user_id
      else null
    end,
    ti.received_by_user_id,
    ti.requested_by_user_id
  ) is not null;
