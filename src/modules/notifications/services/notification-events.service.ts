import { Injectable } from '@nestjs/common';
import { Observable, Subject, interval, merge, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { filter } from 'rxjs/operators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import type { NotificationDto } from '../types/notification.types';

type NotificationCreatedEvent = {
  type: 'notification.created';
  data: NotificationDto;
};

type NotificationReadEvent = {
  type: 'notification.read';
  userId: string;
  data: {
    ids: string[];
    all: boolean;
    unreadCount: number;
  };
};

type NotificationReadyEvent = {
  type: 'notification.ready';
  data: {
    connected: true;
  };
};

type NotificationPingEvent = {
  type: 'notification.ping';
  data: {
    ts: string;
  };
};

export type NotificationRealtimeEvent =
  | NotificationCreatedEvent
  | NotificationReadEvent
  | NotificationReadyEvent
  | NotificationPingEvent;

@Injectable()
export class NotificationEventsService {
  private readonly events$ = new Subject<NotificationRealtimeEvent>();

  streamFor(
    user: AuthenticatedUserProfile,
  ): Observable<NotificationRealtimeEvent> {
    return merge(
      of<NotificationRealtimeEvent>({
        type: 'notification.ready',
        data: { connected: true },
      }),
      interval(25_000).pipe(
        map(() => ({
          type: 'notification.ping' as const,
          data: { ts: new Date().toISOString() },
        })),
      ),
      this.events$.pipe(filter((event) => this.canReceive(user, event))),
    );
  }

  emitCreated(notification: NotificationDto) {
    this.events$.next({
      type: 'notification.created',
      data: notification,
    });
  }

  emitRead(
    user: AuthenticatedUserProfile,
    data: { ids: string[]; all: boolean; unreadCount: number },
  ) {
    this.events$.next({
      type: 'notification.read',
      userId: user.id,
      data,
    });
  }

  private canReceive(
    user: AuthenticatedUserProfile,
    event: NotificationRealtimeEvent,
  ): boolean {
    if (
      event.type === 'notification.ready' ||
      event.type === 'notification.ping'
    ) {
      return true;
    }

    if (event.type === 'notification.read') {
      return event.userId === user.id;
    }

    return this.canSeeNotification(user, event.data);
  }

  private canSeeNotification(
    user: AuthenticatedUserProfile,
    notification: NotificationDto,
  ): boolean {
    if (notification.user_id) {
      return notification.user_id === user.id;
    }

    if (user.role === Role.SUPER_ADMIN) {
      return true;
    }

    if (
      notification.target_role &&
      notification.target_role !== (user.role as string)
    ) {
      return false;
    }

    return (
      Boolean(notification.branch_id) &&
      notification.branch_id === user.branchId
    );
  }
}
