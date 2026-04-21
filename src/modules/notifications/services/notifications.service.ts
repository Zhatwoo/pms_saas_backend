import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class NotificationsService {
  constructor(private supabase: SupabaseService) {}

  async findAll(user: AuthenticatedUserProfile) {
    const client = this.supabase.getClient();

    // Notifications can be:
    // 1. Specifically for this user
    // 2. For this branch (broadcast)
    // 3. For all (broadcast) - branch_id is null

    let query = client
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (user.role !== Role.SUPER_ADMIN) {
      if (user.branchId) {
        query = query.or(
          `branch_id.eq.${user.branchId},user_id.eq.${user.id},branch_id.is.null`,
        );
      } else {
        query = query.or(`user_id.eq.${user.id},branch_id.is.null`);
      }
    }

    const { data, error } = await query;
    if (error) {
      console.error('[NotificationsService] findAll error:', error);
      throw new InternalServerErrorException(error.message);
    }

    return data || [];
  }

  async markAsRead(user: AuthenticatedUserProfile, id: string) {
    const client = this.supabase.getClient();
    const { error } = await client
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { success: true };
  }

  async markAllAsRead(user: AuthenticatedUserProfile) {
    const client = this.supabase.getClient();
    let query = client
      .from('notifications')
      .update({ is_read: true })
      .eq('is_read', false);

    if (user.role !== Role.SUPER_ADMIN) {
      if (user.branchId) {
        query = query.or(
          `branch_id.eq.${user.branchId},user_id.eq.${user.id},branch_id.is.null`,
        );
      } else {
        query = query.or(`user_id.eq.${user.id},branch_id.is.null`);
      }
    }

    const { error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { success: true };
  }

  /**
   * Internal method to create a notification from other services
   */
  async create(payload: {
    title: string;
    subtitle: string;
    category: 'Transactions' | 'Alerts' | 'Requests';
    user_id?: string;
    branch_id?: string;
  }) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('notifications')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error(
        '[NotificationsService] Failed to create notification:',
        error,
      );
      // We don't throw here to avoid failing the main transaction
    }

    return data;
  }
}
