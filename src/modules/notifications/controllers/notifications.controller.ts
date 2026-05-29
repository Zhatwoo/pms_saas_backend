import {
  Controller,
  Get,
  MessageEvent,
  Param,
  Patch,
  Req,
  Sse,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { NotificationsService } from '../services/notifications.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAll(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.notificationsService.findAll(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('unread-count')
  unreadCount(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.notificationsService.unreadCount(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Sse('stream')
  stream(
    @Req() req: { user: AuthenticatedUserProfile },
  ): Observable<MessageEvent> {
    return this.notificationsService.stream(req.user).pipe(
      map((event) => ({
        type: event.type,
        data: event.data,
      })),
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Patch(':id/read')
  markOneAsRead(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.notificationsService.markAsRead(req.user, id);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Patch('read-all')
  markAllAsRead(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.notificationsService.markAllAsRead(req.user);
  }
}
