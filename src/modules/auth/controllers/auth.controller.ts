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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.login(loginDto);

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
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(WAS_LOGGED_IN_COOKIE, { path: '/' });
    return { success: true };
  }

  @Get('me')
  getMe(@Req() req: any) {
    return this.authService.getProfile(req.user.id);
  }

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
  async updateProfilePost(@Req() req: any, @Body() dto: UpdateUserDto) {
    return this.updateProfile(req, dto);
  }

  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() dto: UpdateUserDto) {
    const sanitized: UpdateUserDto = {};
    if (dto.fullName !== undefined) sanitized.fullName = dto.fullName;
    if (dto.avatarUrl !== undefined) sanitized.avatarUrl = dto.avatarUrl;

    return this.usersService.update(req.user.id, sanitized);
  }
}
