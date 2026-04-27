import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { ActivatePasswordChangeRequestDto } from '../dto/activate-password-change-request.dto';
import { CreatePasswordChangeRequestDto } from '../dto/create-password-change-request.dto';
import { ReviewPasswordChangeRequestDto } from '../dto/review-password-change-request.dto';
import { PasswordChangeRequestsService } from '../services/password-change-requests.service';

@Controller('password-change-requests')
export class PasswordChangeRequestsController {
  constructor(
    private readonly passwordChangeRequestsService: PasswordChangeRequestsService,
  ) {}

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: CreatePasswordChangeRequestDto,
  ): Promise<unknown> {
    return this.passwordChangeRequestsService.create(req.user, dto);
  }

  @Roles(Role.ADMIN, Role.EMPLOYEE, Role.SUPER_ADMIN)
  @Get('mine')
  findMine(@Req() req: { user: AuthenticatedUserProfile }): Promise<unknown> {
    return this.passwordChangeRequestsService.findMine(req.user);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Get('pending')
  findPending(@Req() req: { user: AuthenticatedUserProfile }): Promise<unknown> {
    return this.passwordChangeRequestsService.findPendingForReviewer(req.user);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch(':id/review')
  review(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: ReviewPasswordChangeRequestDto,
  ): Promise<unknown> {
    return this.passwordChangeRequestsService.review(req.user, id, dto);
  }

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post(':id/activate')
  activate(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: ActivatePasswordChangeRequestDto,
  ): Promise<unknown> {
    return this.passwordChangeRequestsService.activate(req.user, id, dto);
  }
}
