import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../../infrastructure/prisma';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { BranchDaySessionService } from '../../branch-finance/services/branch-day-session.service';
import { DevicesService } from '../../devices/services/devices.service';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly branchDaySession: BranchDaySessionService,
    private readonly devicesService: DevicesService,
  ) {}

  private isActiveBranchStatus(status: string | null | undefined): boolean {
    return status?.trim().toLowerCase() === 'active';
  }

  async register(registerDto: RegisterDto) {
    try {
      return await this.registerInternal(registerDto);
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `register failed: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw new InternalServerErrorException(
        msg?.trim() ? msg : 'Registration failed',
      );
    }
  }

  private async registerInternal(registerDto: RegisterDto) {
    const client = this.supabaseService.getClient();
    const email = registerDto.email.trim().toLowerCase();
    const fullName = registerDto.fullName.trim();
    const normalizedRole = registerDto.role === 'admin' ? 'admin' : 'employee';

    const branch = await this.prisma.branches.findUnique({
      where: { id: registerDto.branchId },
      select: { id: true, status: true },
    });

    if (!branch || !this.isActiveBranchStatus(branch.status)) {
      throw new BadRequestException('Invalid or inactive branch');
    }

    const { data: authData, error: authError } =
      await client.auth.admin.createUser({
        email,
        password: registerDto.password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
        app_metadata: {
          role: normalizedRole,
          branch_id: registerDto.branchId,
        },
      });

    if (authError || !authData.user) {
      const msg = authError?.message ?? 'Failed to create account';
      if (/already|registered|exists/i.test(msg)) {
        throw new ConflictException('Email already registered');
      }
      throw new BadRequestException(msg);
    }

    const authId = authData.user.id;

    const row = {
      auth_id: authId,
      email,
      full_name: this.encryption.encryptUserFullName(fullName),
      role: normalizedRole,
      branch_id: registerDto.branchId,
      account_status: 'pending' as const,
    };

    // Upsert: DB triggers (or prior inserts) may already create a users row for new auth users.
    try {
      await this.prisma.users.upsert({
        where: { auth_id: authId },
        create: row,
        update: row,
      });
    } catch (error) {
      await client.auth.admin.deleteUser(authId);
      const detail = error instanceof Error ? error.message : '';
      throw new InternalServerErrorException(
        detail || 'Failed to save user profile',
      );
    }

    return {
      message:
        'Registration submitted. A Super Admin must approve your account before you can sign in.',
    };
  }

  async login(loginDto: LoginDto, clientIp?: string) {
    try {
      return await this.loginInternal(loginDto, clientIp);
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `login failed: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw new InternalServerErrorException(msg?.trim() || 'Login failed');
    }
  }

  private async loginInternal(loginDto: LoginDto, clientIp?: string) {
    const authClient = this.supabaseService.getAuthClient();

    const { data, error } = await authClient.auth.signInWithPassword({
      email: loginDto.email,
      password: loginDto.password,
    });

    if (error) {
      await this.devicesService.writeLoginLog({
        deviceFingerprint: loginDto.deviceFingerprint,
        ipAddress: clientIp,
        loginStatus: 'FAILED',
        failureReason: 'INVALID_CREDENTIALS',
      });
      throw new UnauthorizedException(error.message || 'Invalid credentials');
    }

    if (!data?.session?.access_token || !data?.user?.id) {
      throw new InternalServerErrorException(
        'Supabase returned an incomplete session',
      );
    }

    const user = await this.supabaseService.assertSessionUserByAuthId(
      data.user.id,
    );

    // ── Branch IP restriction ─────────────────────────────────────────────────
    if (user.branchId && user.role !== Role.SUPER_ADMIN && clientIp) {
      const branch = await this.prisma.branches.findUnique({
        where: { id: user.branchId },
        select: { allowed_ip: true },
      });

      if (branch?.allowed_ip) {
        const allowedIPs = branch.allowed_ip
          .split(',')
          .map((ip) => ip.trim())
          .filter(Boolean);

        if (allowedIPs.length > 0 && !allowedIPs.includes(clientIp)) {
          await this.devicesService.writeLoginLog({
            employeeId: user.id,
            deviceFingerprint: loginDto.deviceFingerprint,
            ipAddress: clientIp,
            loginStatus: 'BLOCKED',
            failureReason: 'OUTSIDE_BRANCH_NETWORK',
          });
          throw new UnauthorizedException(
            'Outside Branch Network. Login is only allowed from the branch WiFi.',
          );
        }
      }
    }

    // ── Device fingerprint restriction ────────────────────────────────────────
    if (user.role !== Role.SUPER_ADMIN) {
      const fingerprint = loginDto.deviceFingerprint?.trim();
      if (!fingerprint) {
        await this.devicesService.writeLoginLog({
          employeeId: user.id,
          ipAddress: clientIp,
          loginStatus: 'BLOCKED',
          failureReason: 'MISSING_DEVICE_FINGERPRINT',
        });
        throw new ForbiddenException({
          message: 'Device fingerprint is required.',
          code: 'MISSING_DEVICE_FINGERPRINT',
        });
      }

      const deviceCheck = await this.devicesService.validateAndUpdateLastLogin(
        fingerprint,
        user.id,
      );

      if (!deviceCheck.authorized) {
        await this.devicesService.writeLoginLog({
          employeeId: user.id,
          deviceFingerprint: fingerprint,
          ipAddress: clientIp,
          loginStatus: 'BLOCKED',
          failureReason: deviceCheck.reason,
        });

        const messages: Record<string, string> = {
          UNKNOWN_DEVICE: 'Unauthorized Device. Please request authorization from your admin.',
          DEVICE_BLOCKED: 'This device has been blocked. Contact your admin.',
          DEVICE_PENDING: 'Device authorization is pending admin approval.',
        };

        const reason = deviceCheck.reason ?? 'UNKNOWN_DEVICE';
        throw new ForbiddenException({
          message: messages[reason] ?? 'Device not authorized.',
          code: reason,
        });
      }
    }

    // ── Successful login log ──────────────────────────────────────────────────
    await this.devicesService.writeLoginLog({
      employeeId: user.id,
      deviceFingerprint: loginDto.deviceFingerprint,
      ipAddress: clientIp,
      loginStatus: 'SUCCESS',
    });

    let requiresStartingBalance = false;
    if (user.branchId && user.role !== Role.SUPER_ADMIN) {
      requiresStartingBalance =
        await this.branchDaySession.requiresStartingBalance(user.branchId);
    }

    return {
      access_token: data.session.access_token,
      expires_in: data.session.expires_in,
      requiresStartingBalance,
      user: {
        id: user.id,
        authId: user.authId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        branchId: user.branchId,
        avatarUrl: user.avatarUrl,
        notificationSound: user.notificationSound,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.supabaseService.assertSessionUserById(userId);

    return {
      id: user.id,
      authId: user.authId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      branchId: user.branchId,
      avatarUrl: user.avatarUrl,
      notificationSound: user.notificationSound,
    };
  }

  async verifyPassword(authId: string, email: string, password: string) {
    const authClient = this.supabaseService.getAuthClient();

    const { error } = await authClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      this.logger.warn(
        `Password verification failed for ${email}: ${error.message}`,
      );
      return false;
    }

    return true;
  }

  async changePassword(
    user: AuthenticatedUserProfile,
    currentPassword: string,
    newPassword: string,
  ) {
    if (user.role !== Role.SUPER_ADMIN) {
      return this.requestPasswordChange(user, currentPassword, newPassword);
    }

    const trimmedNewPassword = newPassword.trim();

    if (trimmedNewPassword.length < 6) {
      throw new BadRequestException(
        'New password must be at least 6 characters',
      );
    }

    const isCurrentPasswordValid = await this.verifyPassword(
      user.authId,
      user.email,
      currentPassword,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const { error } = await this.supabaseService
      .getClient()
      .auth.admin.updateUserById(user.authId, {
        password: trimmedNewPassword,
      });

    if (error) {
      throw new BadRequestException(
        error.message || 'Failed to update password',
      );
    }

    return { message: 'Password updated successfully' };
  }

  async requestPasswordChange(
    user: AuthenticatedUserProfile,
    currentPassword: string,
    newPassword: string,
  ) {
    const trimmedNewPassword = newPassword.trim();

    if (trimmedNewPassword.length < 6) {
      throw new BadRequestException(
        'New password must be at least 6 characters',
      );
    }

    if (user.role === Role.SUPER_ADMIN) {
      throw new BadRequestException(
        'Super Admin can change password directly without approval',
      );
    }

    const isCurrentPasswordValid = await this.verifyPassword(
      user.authId,
      user.email,
      currentPassword,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const approverRole =
      user.role === Role.ADMIN ? Role.SUPER_ADMIN : Role.ADMIN;

    const { error } = await this.supabaseService
      .getClient()
      .from('activity_logs')
      .insert({
        user_id: user.id,
        branch_id: user.branchId || null,
        action: 'PASSWORD_CHANGE_REQUEST',
        details: JSON.stringify({
          requestStatus: 'pending',
          requestedByUserId: user.id,
          requestedByRole: user.role,
          approverRole,
          requestedAt: new Date().toISOString(),
          // Avoid storing passwords in logs; requester will submit the new password after approval.
          requiresPasswordResubmission: true,
        }),
      });

    if (error) {
      throw new BadRequestException(
        error.message || 'Failed to submit request',
      );
    }

    return {
      message:
        approverRole === Role.SUPER_ADMIN
          ? 'Password change request sent to Super Admin for approval'
          : 'Password change request sent to Branch Admin for approval',
    };
  }

  private parseActivityLogDetails(details: unknown): Record<string, any> {
    if (!details) {
      return {};
    }

    if (typeof details === 'object' && details !== null) {
      return details as Record<string, any>;
    }

    if (typeof details !== 'string') {
      return {};
    }

    try {
      const parsed = JSON.parse(details);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, any>)
        : {};
    } catch {
      return {};
    }
  }

  async getPasswordChangeRequests(user: AuthenticatedUserProfile) {
    if (user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN) {
      throw new UnauthorizedException(
        'Only admins can view password change requests',
      );
    }

    const client = this.supabaseService.getClient();
    let query = client
      .from('activity_logs')
      .select('id, user_id, branch_id, action, details, created_at')
      .eq('action', 'PASSWORD_CHANGE_REQUEST')
      .order('created_at', { ascending: false })
      .limit(200);

    if (user.role === Role.ADMIN) {
      if (!user.branchId) {
        throw new BadRequestException('Admin account has no assigned branch');
      }
      query = query.eq('branch_id', user.branchId);
    }

    const { data: logs, error: logsError } = await query;

    if (logsError) {
      throw new InternalServerErrorException(
        logsError.message || 'Failed to fetch password requests',
      );
    }

    const approverRole = user.role;
    const pendingLogs = (logs || []).filter((row: any) => {
      const details = this.parseActivityLogDetails(row.details);
      const requestStatus =
        typeof details.requestStatus === 'string'
          ? details.requestStatus.toLowerCase()
          : 'pending';
      const intendedApprover =
        typeof details.approverRole === 'string' ? details.approverRole : '';

      return requestStatus === 'pending' && intendedApprover === approverRole;
    });

    const requesterIds = Array.from(
      new Set(
        pendingLogs
          .map((row: any) =>
            typeof row.user_id === 'string' ? row.user_id : null,
          )
          .filter((value: string | null): value is string => Boolean(value)),
      ),
    );

    const userMap = new Map<
      string,
      { full_name: string | null; role: string | null }
    >();

    if (requesterIds.length > 0) {
      const { data: users, error: usersError } = await client
        .from('users')
        .select('id, full_name, role')
        .in('id', requesterIds);

      if (usersError) {
        throw new InternalServerErrorException(
          usersError.message || 'Failed to resolve requesters',
        );
      }

      for (const requester of users || []) {
        if (typeof requester.id !== 'string') {
          continue;
        }

        userMap.set(requester.id, {
          full_name:
            requester.full_name == null
              ? null
              : this.encryption.decryptUserFullName(
                  String(requester.full_name),
                ),
          role: requester.role == null ? null : String(requester.role),
        });
      }
    }

    return pendingLogs.map((row: any) => {
      const details = this.parseActivityLogDetails(row.details);
      const requester = userMap.get(row.user_id);

      return {
        id: row.id,
        requestStatus:
          typeof details.requestStatus === 'string'
            ? details.requestStatus
            : 'pending',
        requestedAt:
          typeof details.requestedAt === 'string'
            ? details.requestedAt
            : row.created_at,
        requestedByUserId:
          typeof details.requestedByUserId === 'string'
            ? details.requestedByUserId
            : row.user_id,
        requestedByRole:
          typeof details.requestedByRole === 'string'
            ? details.requestedByRole
            : requester?.role || 'employee',
        requestedByName:
          typeof details.requestedByName === 'string'
            ? details.requestedByName
            : requester?.full_name || 'Unknown user',
        approverRole:
          typeof details.approverRole === 'string'
            ? details.approverRole
            : null,
        branchId: row.branch_id || null,
      };
    });
  }

  async reviewPasswordChangeRequest(
    reviewer: AuthenticatedUserProfile,
    requestId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ) {
    if (reviewer.role !== Role.ADMIN && reviewer.role !== Role.SUPER_ADMIN) {
      throw new UnauthorizedException(
        'Only admins can review password change requests',
      );
    }

    const normalizedDecision = String(decision || '').toLowerCase();
    if (normalizedDecision !== 'approve' && normalizedDecision !== 'reject') {
      throw new BadRequestException('Decision must be "approve" or "reject"');
    }

    const safeNote = typeof note === 'string' ? note.trim() : '';
    if (safeNote.length > 500) {
      throw new BadRequestException('Review note is too long');
    }

    const client = this.supabaseService.getClient();
    const { data: logRow, error: logError } = await client
      .from('activity_logs')
      .select('id, user_id, branch_id, action, details, created_at')
      .eq('id', requestId)
      .eq('action', 'PASSWORD_CHANGE_REQUEST')
      .maybeSingle();

    if (logError) {
      throw new InternalServerErrorException(
        logError.message || 'Failed to fetch request',
      );
    }

    if (!logRow) {
      throw new NotFoundException('Password change request not found');
    }

    if (reviewer.role === Role.ADMIN) {
      if (!reviewer.branchId) {
        throw new BadRequestException('Admin account has no assigned branch');
      }

      if (!logRow.branch_id || logRow.branch_id !== reviewer.branchId) {
        throw new UnauthorizedException('Request belongs to another branch');
      }
    }

    const parsedDetails = this.parseActivityLogDetails(logRow.details);
    const requestStatus =
      typeof parsedDetails.requestStatus === 'string'
        ? parsedDetails.requestStatus.toLowerCase()
        : 'pending';

    if (requestStatus !== 'pending') {
      throw new ConflictException('Request was already reviewed');
    }

    const approverRole =
      typeof parsedDetails.approverRole === 'string'
        ? parsedDetails.approverRole
        : null;

    if (!approverRole || approverRole !== reviewer.role) {
      throw new UnauthorizedException(
        'You are not allowed to review this request',
      );
    }

    const reviewedAt = new Date().toISOString();
    const nextStatus =
      normalizedDecision === 'approve' ? 'approved' : 'rejected';

    const reviewDetails = {
      ...parsedDetails,
      requestStatus: nextStatus,
      reviewedAt,
      reviewedByUserId: reviewer.id,
      reviewedByRole: reviewer.role,
      reviewNote: safeNote || null,
      requiresPasswordResubmission: true,
    };

    const { error: updateError } = await client
      .from('activity_logs')
      .update({ details: JSON.stringify(reviewDetails) })
      .eq('id', requestId);

    if (updateError) {
      throw new InternalServerErrorException(
        updateError.message || 'Failed to update request review',
      );
    }

    const reviewAction =
      normalizedDecision === 'approve'
        ? 'PASSWORD_CHANGE_REQUEST_APPROVED'
        : 'PASSWORD_CHANGE_REQUEST_REJECTED';

    const { error: reviewLogError } = await client
      .from('activity_logs')
      .insert({
        user_id: reviewer.id,
        branch_id: logRow.branch_id || null,
        action: reviewAction,
        details: JSON.stringify({
          requestId,
          requestedByUserId:
            typeof parsedDetails.requestedByUserId === 'string'
              ? parsedDetails.requestedByUserId
              : logRow.user_id,
          requestedByRole:
            typeof parsedDetails.requestedByRole === 'string'
              ? parsedDetails.requestedByRole
              : null,
          reviewedAt,
          reviewedByUserId: reviewer.id,
          reviewedByRole: reviewer.role,
          reviewNote: safeNote || null,
        }),
      });

    if (reviewLogError) {
      this.logger.warn(
        `Failed to write password review audit log: ${reviewLogError.message}`,
      );
    }

    return {
      message:
        normalizedDecision === 'approve'
          ? 'Password change request approved'
          : 'Password change request rejected',
      requestId,
      status: nextStatus,
      requiresPasswordResubmission: true,
    };
  }
}
