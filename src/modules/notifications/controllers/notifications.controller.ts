import { Controller, Get, Patch, Param, Req } from '@nestjs/common';
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
