import type { notifications } from '@prisma/client';

export type NotificationCategory = 'Transactions' | 'Alerts' | 'Requests';
export type NotificationEntityType =
  | 'transaction'
  | 'payment'
  | 'redemption'
  | 'branch'
  | 'user'
  | 'pawn_item'
  | 'customer'
  | 'fund_request'
  | 'fund_transfer'
  | 'incident_ticket'
  | 'password_request'
  | 'user_branch_transfer'
  | 'inventory_transfer'
  | 'system';

export type NotificationCreateInput = {
  title: string;
  subtitle?: string | null;
  message?: string | null;
  category: NotificationCategory;
  notification_type?: string | null;
  user_id?: string | null;
  branch_id?: string | null;
  customer_id?: string | null;
  log_id?: string | null;
  event_key?: string | null;
  target_role?: string | null;
  target_url?: string | null;
  entity_type?: NotificationEntityType | (string & {}) | null;
  entity_id?: string | null;
  environment?: string | null;
  created_by?: string | null;
};

export type NotificationDto = {
  id: string;
  user_id: string | null;
  branch_id: string | null;
  title: string;
  subtitle: string | null;
  message: string | null;
  category: string | null;
  notification_type: string | null;
  target_url: string | null;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  read_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  customer_id: string | null;
  log_id: string | null;
  event_key: string | null;
  target_role: string | null;
  environment: string;
  created_by: string | null;
};

export function toNotificationDto(row: notifications): NotificationDto {
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    branch_id: row.branch_id ?? null,
    title: row.title,
    subtitle: row.subtitle ?? null,
    message: row.message ?? row.subtitle ?? null,
    category: row.category ?? null,
    notification_type: row.notification_type ?? null,
    target_url: row.target_url ?? null,
    entity_type: row.entity_type ?? null,
    entity_id: row.entity_id ?? null,
    is_read: Boolean(row.is_read),
    read_at: row.read_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    customer_id: row.customer_id ?? null,
    log_id: row.log_id ?? null,
    event_key: row.event_key ?? null,
    target_role: row.target_role ?? null,
    environment: row.environment,
    created_by: row.created_by ?? null,
  };
}
