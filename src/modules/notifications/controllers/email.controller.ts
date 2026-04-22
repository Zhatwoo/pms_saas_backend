import { Controller, Post, Req, Param } from '@nestjs/common';
import { EmailService } from '../services/email.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('send-expiration-blast/:category')
  async sendExpirationBlast(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('category') category: 'overdue' | 'threeDays' | 'sevenDays' | 'thirtyDays',
  ) {
    const branchId = req.user.role === Role.SUPER_ADMIN ? undefined : (req.user.branchId || undefined);

    return this.emailService.sendExpirationBlast(req.user, {
      category,
      branchId,
    });
  }
}
