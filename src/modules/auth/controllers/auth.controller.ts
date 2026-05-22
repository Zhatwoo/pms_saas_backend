import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AUTH_STRICT_THROTTLE } from '../../../config/throttle-auth.constants';
import { AuthService } from '../services/auth.service';
import { BranchesService } from '../../branches/services/branches.service';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { VerifyPasswordDto } from '../dto/verify-password.dto';
import { UpdateUserDto } from '../../users/dto/update-user.dto';
import { UsersService } from '../../users/services/users.service';
import { Public } from '../../../common/decorators';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

const ACCESS_TOKEN_COOKIE = 'pms_access_token';
const WAS_LOGGED_IN_COOKIE = 'pms_was_logged_in';

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

function rememberedCookieOptions(maxAgeSeconds = 2_592_000) {
  return {
    httpOnly: false,
    secure: isProduction(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly branchesService: BranchesService,
    private readonly usersService: UsersService,
  ) {}

  /** Public branch list for signup (avoids /branches/:id catching "public"). */
  @Public()
  @Get('signup/branches')
  signupBranches() {
    return this.branchesService.findActiveSummaries();
  }

  @Public()
  // Strict auth surface: brute-force / credential stuffing mitigation (aligned with THROTTLE_AUTH_* env).
  @Throttle(AUTH_STRICT_THROTTLE)
  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Throttle(AUTH_STRICT_THROTTLE)
  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req: any,
  ) {
    const clientIp: string =
      (req.headers?.['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ||
      req.socket?.remoteAddress ||
      '';
    const session = await this.authService.login(loginDto, clientIp);

    res.cookie(
      ACCESS_TOKEN_COOKIE,
      session.access_token,
      accessCookieOptions(session.expires_in),
    );
    res.cookie(WAS_LOGGED_IN_COOKIE, '1', rememberedCookieOptions());

    return { user: session.user };
  }

  @Public()
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
    });
    res.clearCookie(WAS_LOGGED_IN_COOKIE, {
      path: '/',
      secure: isProduction(),
      sameSite: 'lax',
    });
    return { success: true };
  }

  @Get('me')
  getMe(@Req() req: any) {
    return this.authService.getProfile(req.user.id);
  }

  /** Confirms possession of password before sensitive actions — rate-limit like login. */
  @Throttle(AUTH_STRICT_THROTTLE)
  @Post('verify-password')
  async verify(@Req() req: any, @Body() dto: VerifyPasswordDto) {
    const isValid = await this.authService.verifyPassword(
      req.user.authId,
      req.user.email,
      dto.password,
    );

    if (!isValid) {
      throw new BadRequestException('Invalid password');
    }

    return { success: true };
  }

  @Throttle(AUTH_STRICT_THROTTLE)
  @Post('change-password')
  async changePassword(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      req.user,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @Throttle(AUTH_STRICT_THROTTLE)
  @Post('change-password-request')
  async requestChangePassword(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.requestPasswordChange(
      req.user,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @Throttle(AUTH_STRICT_THROTTLE)
  @Post('request-change-password')
  async requestChangePasswordLegacyPath(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.requestPasswordChange(
      req.user,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get('password-change-requests')
  getPasswordChangeRequests(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('status') _status?: string,
  ) {
    return this.authService.getPasswordChangeRequests(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  /** Admin review affects account credentials — tighter limits reduce abuse/noise. */
  @Throttle(AUTH_STRICT_THROTTLE)
  @Patch('password-change-requests/:requestId/review')
  reviewPasswordChangeRequest(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('requestId') requestId: string,
    @Body() dto: { decision?: 'approve' | 'reject'; note?: string },
  ) {
    return this.authService.reviewPasswordChangeRequest(
      req.user,
      requestId,
      dto?.decision || 'reject',
      dto?.note,
    );
  }

  @Post('profile') // Turbopack workaround: using POST for updates
  async updateProfilePost(
    @Req()
    req: {
      user: AuthenticatedUserProfile;
      auditLogContext?: Record<string, unknown>;
    },
    @Body() dto: UpdateUserDto,
  ) {
    return this.updateProfile(req, dto);
  }

  @Patch('profile')
  async updateProfile(
    @Req()
    req: {
      user: AuthenticatedUserProfile;
      auditLogContext?: Record<string, unknown>;
    },
    @Body() dto: UpdateUserDto,
  ) {
    const sanitized: UpdateUserDto = {};
    if (dto.fullName !== undefined) sanitized.fullName = dto.fullName;
    if (dto.avatarUrl !== undefined) sanitized.avatarUrl = dto.avatarUrl;

    const updated = await this.usersService.update(req.user.id, sanitized);
    req.auditLogContext = {
      targetUserId: updated.id,
      targetUserName: updated.fullName ?? updated.email,
      changedFields: Object.keys(sanitized),
    };
    return updated;
  }
}
