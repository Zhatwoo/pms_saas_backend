import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AUTH_STRICT_THROTTLE } from '../../../config/throttle-auth.constants';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { ActivatePasswordChangeRequestDto } from '../dto/activate-password-change-request.dto';
import { CreatePasswordChangeRequestDto } from '../dto/create-password-change-request.dto';
import { ReviewPasswordChangeRequestDto } from '../dto/review-password-change-request.dto';
import { PasswordChangeRequestsService } from '../services/password-change-requests.service';

const ACCESS_TOKEN_COOKIE = 'pms_access_token';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function accessCookieOptions(maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.max(1, maxAgeSeconds ?? 3600) * 1000,
  };
}

@Controller('password-change-requests')
export class PasswordChangeRequestsController {
  constructor(
    private readonly passwordChangeRequestsService: PasswordChangeRequestsService,
  ) {}

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  /** Creates org-level password-reset intent — constrain spam / confused loops. */
  @Throttle(AUTH_STRICT_THROTTLE)
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
  findPending(
    @Req() req: { user: AuthenticatedUserProfile },
  ): Promise<unknown> {
    return this.passwordChangeRequestsService.findPendingForReviewer(req.user);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Throttle(AUTH_STRICT_THROTTLE)
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
  async activate(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: ActivatePasswordChangeRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.passwordChangeRequestsService.activate(
      req.user,
      id,
      dto,
    );

    if (result.access_token) {
      res.cookie(
        ACCESS_TOKEN_COOKIE,
        result.access_token,
        accessCookieOptions(result.expires_in),
      );
    }

    return {
      success: true,
      message: result.message,
      access_token: result.access_token,
      expires_in: result.expires_in,
    };
  }
}
