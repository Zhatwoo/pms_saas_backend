import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { Prisma } from '@prisma/client';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { NotificationEventsService } from './notification-events.service';
import {
  getEnvironment,
  isDeveloper,
} from '../../../common/utils/authorization.util';
import {
  NotificationCreateInput,
  NotificationDto,
  NotificationEntityType,
  toNotificationDto,
} from '../types/notification.types';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: NotificationEventsService,
  ) {}

  async findAll(user: AuthenticatedUserProfile) {
    try {
      const rows = await this.prisma.notifications.findMany({
        where: this.buildVisibilityWhere(user),
        orderBy: { created_at: 'desc' },
        take: 50,
      });

      return rows.map(toNotificationDto);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(message);
    }
  }

  async unreadCount(user: AuthenticatedUserProfile) {
    return { unreadCount: await this.countUnread(user) };
  }

  stream(user: AuthenticatedUserProfile) {
    return this.events.streamFor(user);
  }

  async markAsRead(user: AuthenticatedUserProfile, id: string) {
    if (!this.isUuid(id)) {
      throw new BadRequestException('Invalid notification id');
    }

    const existing = await this.prisma.notifications.findFirst({
      where: {
        id,
        AND: [this.buildVisibilityWhere(user)],
      },
    });

    if (!existing) {
      throw new NotFoundException('Notification not found');
    }

    const notification = toNotificationDto(existing);
    if (!this.canMutate(user, notification)) {
      throw new ForbiddenException('You cannot update this notification');
    }

    const updated = await this.prisma.notifications.update({
      where: { id: existing.id },
      data: {
        is_read: true,
        read_at: existing.read_at ?? new Date(),
      },
    });

    const unreadCount = await this.countUnread(user);
    this.events.emitRead(user, { ids: [existing.id], all: false, unreadCount });

    return {
      success: true,
      unreadCount,
      notification: toNotificationDto(updated),
    };
  }

  async markAllAsRead(user: AuthenticatedUserProfile) {
    const where: Prisma.notificationsWhereInput = {
      is_read: false,
      AND: [this.buildVisibilityWhere(user), this.buildMutableWhere(user)],
    };

    const rows = await this.prisma.notifications.findMany({
      where,
      select: { id: true },
      take: 500,
    });

    await this.prisma.notifications.updateMany({
      where,
      data: { is_read: true, read_at: new Date() },
    });

    const unreadCount = await this.countUnread(user);
    this.events.emitRead(user, {
      ids: rows.map((row) => row.id),
      all: true,
      unreadCount,
    });

    return { success: true, unreadCount };
  }

  async create(payload: NotificationCreateInput): Promise<NotificationDto | null> {
    try {
      const eventKey = payload.event_key?.trim() || null;
      if (eventKey) {
        const existing = await this.prisma.notifications.findUnique({
          where: { event_key: eventKey },
        });

        if (existing) {
          return toNotificationDto(existing);
        }
      }

      const data = {
        ...payload,
        message: payload.message ?? payload.subtitle ?? null,
        subtitle: payload.subtitle ?? null,
        notification_type:
          payload.notification_type ?? payload.entity_type ?? payload.category,
        user_id: payload.user_id ?? null,
        branch_id: payload.branch_id ?? null,
        customer_id: payload.customer_id ?? null,
        log_id: payload.log_id ?? null,
        event_key: eventKey,
        target_role: payload.target_role ?? null,
        target_url: payload.target_url ?? this.buildTargetUrl(payload),
        entity_type: payload.entity_type ?? null,
        entity_id: payload.entity_id ?? null,
        environment: payload.environment ?? 'production',
        created_by: payload.created_by ?? null,
      };

      const row = await this.prisma.notifications.create({ data });
      const notification = toNotificationDto(row);

      this.events.emitCreated(notification);
      return notification;
    } catch (error) {
      console.error(
        '[NotificationsService] Failed to create notification:',
        error,
      );
      return null;
    }
  }

  async createForSuperadmins(
    payload: Omit<NotificationCreateInput, 'target_role' | 'user_id'>,
  ): Promise<NotificationDto | null> {
    return this.create({
      ...payload,
      target_role: Role.SUPER_ADMIN,
      user_id: null,
      branch_id: null,
    });
  }

  private buildVisibilityWhere(user: AuthenticatedUserProfile) {
    const environment = getEnvironment(user);

    if (isDeveloper(user)) {
      return {
        environment,
        created_by: user.authId,
      };
    }

    if (user.role === Role.SUPER_ADMIN) {
      return {
        environment,
        OR: [
          { user_id: user.id },
          {
            user_id: null,
            OR: [{ target_role: null }, { target_role: Role.SUPER_ADMIN }],
          },
        ],
      };
    }

    const scoped: Prisma.notificationsWhereInput[] = [{ user_id: user.id }];
    if (user.branchId) {
      scoped.push({
        user_id: null,
        branch_id: user.branchId,
        OR: [{ target_role: null }, { target_role: user.role }],
      });
    }

    return { environment, OR: scoped };
  }

  private buildMutableWhere(user: AuthenticatedUserProfile) {
    const environment = getEnvironment(user);

    if (isDeveloper(user)) {
      return {
        environment,
        created_by: user.authId,
      };
    }

    if (user.role === Role.SUPER_ADMIN) {
      return {
        environment,
        OR: [
          { user_id: user.id },
          {
            user_id: null,
            OR: [{ target_role: null }, { target_role: Role.SUPER_ADMIN }],
          },
        ],
      };
    }

    const scoped: Prisma.notificationsWhereInput[] = [{ user_id: user.id }];
    if (user.branchId) {
      scoped.push({
        user_id: null,
        branch_id: user.branchId,
        OR: [{ target_role: null }, { target_role: user.role }],
      });
    }

    return { environment, OR: scoped };
  }

  private canMutate(
    user: AuthenticatedUserProfile,
    notification: NotificationDto,
  ): boolean {
    if (user.role === Role.SUPER_ADMIN) {
      return notification.user_id === user.id || !notification.user_id;
    }

    return (
      notification.user_id === user.id ||
      (!notification.user_id &&
        Boolean(notification.branch_id) &&
        notification.branch_id === user.branchId)
    );
  }

  private countUnread(user: AuthenticatedUserProfile) {
    return this.prisma.notifications.count({
      where: {
        is_read: false,
        AND: [this.buildVisibilityWhere(user)],
      },
    });
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private buildTargetUrl(payload: NotificationCreateInput): string | null {
    const entityType = payload.entity_type as NotificationEntityType | undefined;
    const entityId = payload.entity_id ?? null;

    if (payload.customer_id) {
      const params = new URLSearchParams({ id: payload.customer_id });
      if (payload.log_id) params.set('highlightLogId', payload.log_id);
      return `/customers/view_user?${params.toString()}`;
    }

    if (!entityType || !entityId) {
      return null;
    }

    switch (entityType) {
      case 'transaction':
      case 'payment':
      case 'redemption':
        return `/pawn-transactions?transactionNo=${encodeURIComponent(
          entityId,
        )}&highlightTransaction=true`;
      case 'branch':
        return `/branches?branchId=${encodeURIComponent(entityId)}`;
      case 'user':
        return `/users?userId=${encodeURIComponent(entityId)}`;
      case 'pawn_item':
        return `/expiration-monitoring?ticketNo=${encodeURIComponent(
          entityId,
        )}&highlightTransaction=true`;
      case 'fund_request':
      case 'fund_transfer':
        return entityId
          ? `/branch-finance?fundRequestId=${encodeURIComponent(entityId)}`
          : '/branch-finance';
      case 'incident_ticket':
        return entityId
          ? `/incident-report?ticketId=${encodeURIComponent(entityId)}`
          : '/incident-report';
      case 'user_branch_transfer':
        return '/dashboard';
      case 'password_request':
        return '/settings';
      case 'system':
        return '/audit-logs';
      default:
        return null;
    }
  }
}
