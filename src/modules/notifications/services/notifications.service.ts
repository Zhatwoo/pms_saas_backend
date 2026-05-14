import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(user: AuthenticatedUserProfile) {
    // Notifications can be:
    // 1. Specifically for this user
    // 2. For this branch (broadcast)
    // 3. For all (broadcast) - branch_id is null

    try {
      const where =
        user.role === Role.SUPER_ADMIN
          ? {}
          : user.branchId
            ? {
                OR: [
                  { branch_id: user.branchId },
                  { user_id: user.id },
                  { branch_id: null },
                ],
              }
            : { OR: [{ user_id: user.id }, { branch_id: null }] };

      return await this.prisma.notifications.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: 50,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(message);
    }
  }

  async markAsRead(user: AuthenticatedUserProfile, id: string) {
    await this.prisma.notifications.updateMany({
      where: { id },
      data: { is_read: true },
    });

    return { success: true };
  }

  async markAllAsRead(user: AuthenticatedUserProfile) {
    const where =
      user.role === Role.SUPER_ADMIN
        ? { is_read: false }
        : user.branchId
          ? {
              is_read: false,
              OR: [
                { branch_id: user.branchId },
                { user_id: user.id },
                { branch_id: null },
              ],
            }
          : { is_read: false, OR: [{ user_id: user.id }, { branch_id: null }] };

    await this.prisma.notifications.updateMany({
      where,
      data: { is_read: true },
    });

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
    customer_id?: string;
    log_id?: string;
  }) {
    try {
      return await this.prisma.notifications.create({ data: payload });
    } catch (error) {
      console.error('[NotificationsService] Failed to create notification:', error);
      // We don't throw here to avoid failing the main transaction
      return null;
    }
  }
}
