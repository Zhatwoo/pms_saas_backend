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
import {
  environmentCreateFields,
  isDeveloper,
  getEnvironment,
} from '../../../common/utils/authorization.util';
import nodemailer from 'nodemailer';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';

interface PasswordOtpStore {
  code: string;
  expiresAt: number;
}

// Rows fetched via the untyped Supabase client come back as `any`; this
// interface pins down the shape actually selected by the queries below.
interface PasswordChangeLogRow {
  id: string;
  user_id: string;
  branch_id: string | null;
  action: string;
  details: unknown;
  created_at: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly passwordOtpCache = new Map<string, PasswordOtpStore>();
  private readonly forgotPasswordOtpCache = new Map<string, PasswordOtpStore>();

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
    const developer = isDeveloper({ email });

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
      is_developer: developer,
      environment: getEnvironment({ email, isDeveloper: developer }),
      created_by: authId,
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
    const effectiveIsDeveloper =
      user.isDeveloper ||
      isDeveloper({ email: loginDto.email }) ||
      isDeveloper({ email: data.user.email ?? null });
    const userEnvironment = getEnvironment({
      email: user.email,
      isDeveloper: effectiveIsDeveloper,
    });

    // ── Branch IP restriction ─────────────────────────────────────────────────
    if (
      !effectiveIsDeveloper &&
      user.branchId &&
      user.role !== Role.SUPER_ADMIN &&
      clientIp
    ) {
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
            authId: user.authId,
            environment: userEnvironment,
          });
          throw new UnauthorizedException(
            'Outside Branch Network. Login is only allowed from the branch WiFi.',
          );
        }
      }
    }

    // ── Device fingerprint restriction ────────────────────────────────────────
    if (!effectiveIsDeveloper && user.role !== Role.SUPER_ADMIN) {
      const fingerprint = loginDto.deviceFingerprint?.trim();
      if (!fingerprint) {
        await this.devicesService.writeLoginLog({
          employeeId: user.id,
          ipAddress: clientIp,
          loginStatus: 'BLOCKED',
          failureReason: 'MISSING_DEVICE_FINGERPRINT',
          authId: user.authId,
          environment: userEnvironment,
        });
        throw new ForbiddenException({
          message: 'Device fingerprint is required.',
          code: 'MISSING_DEVICE_FINGERPRINT',
        });
      }

      const deviceCheck = await this.devicesService.validateAndUpdateLastLogin(
        user,
        fingerprint,
      );

      if (!deviceCheck.authorized) {
        await this.devicesService.writeLoginLog({
          employeeId: user.id,
          deviceFingerprint: fingerprint,
          ipAddress: clientIp,
          loginStatus: 'BLOCKED',
          failureReason: deviceCheck.reason,
          authId: user.authId,
          environment: userEnvironment,
        });

        const messages: Record<string, string> = {
          UNKNOWN_DEVICE:
            'Unauthorized Device. Please request authorization from your admin.',
          DEVICE_BLOCKED: 'This device has been blocked. Contact your admin.',
          DEVICE_PENDING: 'Device authorization is pending admin approval.',
        };

        const reason = deviceCheck.reason ?? 'UNKNOWN_DEVICE';
        let autoRequested = false;

        if (reason === 'UNKNOWN_DEVICE') {
          try {
            await this.devicesService.requestAuthorization(
              user.id,
              {
                deviceFingerprint: fingerprint,
                deviceType: 'DESKTOP',
                email: loginDto.email,
              },
              clientIp ?? '',
              userEnvironment,
            );
            autoRequested = true;
          } catch (reqErr) {
            this.logger.warn(
              `Auto device authorization request failed for ${user.id}: ${
                reqErr instanceof Error ? reqErr.message : String(reqErr)
              }`,
            );
          }
        }

        throw new ForbiddenException({
          message: messages[reason] ?? 'Device not authorized.',
          code: reason,
          autoRequested,
        });
      }
    }

    // ── Successful login log ──────────────────────────────────────────────────
    await this.devicesService.writeLoginLog({
      employeeId: user.id,
      deviceFingerprint: loginDto.deviceFingerprint,
      ipAddress: clientIp,
      loginStatus: 'SUCCESS',
      authId: user.authId,
      environment: userEnvironment,
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
        isDeveloper: effectiveIsDeveloper,
        onboardingCompleted: user.onboardingCompleted,
        subscriptionPlan: { name: 'Standard Plan', maxBranches: 1 },
        environment: userEnvironment,
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
      isDeveloper: user.isDeveloper,
      onboardingCompleted: user.onboardingCompleted,
      subscriptionPlan: { name: 'Standard Plan', maxBranches: 1 },
      environment: getEnvironment(user),
    };
  }

  async completeOnboarding(
    user: AuthenticatedUserProfile,
    dto: { branchName: string; location: string; contactNumber: string; contactType?: string },
  ) {
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only Super Admin can complete onboarding');
    }

    const branchName = dto.branchName?.trim();
    const location = dto.location?.trim();
    const contactNumber = dto.contactNumber?.trim();
    const contactType = dto.contactType?.trim().toLowerCase() || 'mobile';

    if (!branchName) {
      throw new BadRequestException('Branch name is required');
    }
    if (!location) {
      throw new BadRequestException('Branch location is required');
    }
    if (!contactNumber) {
      throw new BadRequestException('Contact number is required');
    }

    const digitsOnly = contactNumber.replace(/\D/g, '');
    if (contactType === 'mobile') {
      if (!/^09\d{9}$/.test(digitsOnly)) {
        throw new BadRequestException(
          'Mobile number must be exactly 11 digits starting with 09 (e.g. 09XXXXXXXXX)',
        );
      }
    } else if (contactType === 'telephone') {
      if (digitsOnly.length < 7 || digitsOnly.length > 15) {
        throw new BadRequestException(
          'Telephone number must be between 7 and 15 digits',
        );
      }
    }

    // Resolve tenantId if not already present on user profile object
    let tenantId = user.tenantId ?? null;
    if (!tenantId) {
      const dbUser = await this.prisma.users.findUnique({
        where: { id: user.id },
        select: { tenant_id: true },
      });
      tenantId = dbUser?.tenant_id ?? null;
    }

    const rows = await this.prisma.branches.findMany({
      where: tenantId ? { tenant_id: tenantId } : {},
      select: { branch_code: true },
    });
    const usedCodes = new Set(rows.map((row) => row.branch_code));
    let branchCode = '001';
    for (let i = 1; i <= 9999; i++) {
      const candidate = String(i).padStart(3, '0');
      if (!usedCodes.has(candidate)) {
        branchCode = candidate;
        break;
      }
    }

    const encryptedContact = this.encryption.encryptBranchContactNumber(contactNumber);

    const branch = await this.prisma.branches.create({
      data: {
        name: branchName,
        branch_code: branchCode,
        location,
        contact_number: encryptedContact,
        status: 'Active',
        ...(tenantId ? { tenant_id: tenantId } : {}),
        created_by: user.id,
      },
    });

    await this.prisma.users.update({
      where: { id: user.id },
      data: {
        branch_id: branch.id,
        onboarding_completed: true,
      },
    });

    if (tenantId) {
      await this.prisma.tenants
        .update({
          where: { id: tenantId },
          data: { onboarding_completed: true },
        })
        .catch(() => {});
    }

    return await this.getProfile(user.id);
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

  async requestPasswordOtp(
    user: AuthenticatedUserProfile,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) {
    const trimmedCurrentPassword = currentPassword?.trim() ?? '';
    const trimmedNewPassword = newPassword?.trim() ?? '';
    const trimmedConfirmPassword = confirmPassword?.trim() ?? '';

    if (!trimmedCurrentPassword) {
      throw new BadRequestException('Current password is required');
    }

    if (trimmedNewPassword.length < 6) {
      throw new BadRequestException('New password must be at least 6 characters');
    }

    if (trimmedNewPassword !== trimmedConfirmPassword) {
      throw new BadRequestException('New password confirmation does not match');
    }

    if (trimmedCurrentPassword === trimmedNewPassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    const isCurrentPasswordValid = await this.verifyPassword(
      user.authId,
      user.email,
      trimmedCurrentPassword,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Generate 6-digit numeric OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiration

    this.passwordOtpCache.set(user.email.toLowerCase(), {
      code: otpCode,
      expiresAt,
    });

    // Send email via Nodemailer
    const userEmail = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = process.env.SMTP_SECURE !== 'false';
    const fromName = process.env.SMTP_FROM_NAME || 'QuickPawn';

    if (!userEmail || !pass) {
      this.logger.error('Email credentials not configured (GMAIL_USER or GMAIL_APP_PASSWORD missing)');
      throw new InternalServerErrorException('Email service is not configured');
    }

    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user: userEmail,
          pass,
        },
      });

      await transporter.sendMail({
        from: `"${fromName}" <${userEmail}>`,
        to: user.email,
        subject: `[${otpCode}] Password Change Verification Code - PMS SaaS`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; background-color: #ffffff;">
            <div style="text-align: center; padding-bottom: 15px; border-bottom: 2px solid #10b981;">
              <h2 style="color: #111827; margin: 0;">Password Change Verification</h2>
            </div>
            <div style="padding: 20px 0; color: #374151; font-size: 14px; line-height: 1.6;">
              <p>Hello <strong>${user.fullName || 'User'}</strong>,</p>
              <p>We received a request to change your password for your PMS SaaS account. Use the 6-digit verification code below to complete your password change:</p>

              <div style="text-align: center; margin: 25px 0;">
                <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #059669; background-color: #ecfdf5; padding: 10px 24px; border-radius: 8px; border: 1px dashed #10b981;">
                  ${otpCode}
                </span>
              </div>

              <p style="font-size: 13px; color: #6b7280; text-align: center;">This code will expire in <strong>10 minutes</strong>.</p>
              <p style="font-size: 12px; color: #9ca3af; margin-top: 20px;">If you did not request this password change, please ignore this email.</p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Sent password change OTP code to ${user.email}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send password change OTP to ${user.email}: ${msg}`);
      throw new InternalServerErrorException('Failed to send verification code email');
    }

    return { message: 'Verification code sent to your email.' };
  }

  async verifyPasswordOtpAndChange(
    user: AuthenticatedUserProfile,
    currentPassword: string,
    newPassword: string,
    otp: string,
  ) {
    const trimmedOtp = otp?.trim() ?? '';
    const trimmedNewPassword = newPassword?.trim() ?? '';
    const trimmedCurrentPassword = currentPassword?.trim() ?? '';

    if (!trimmedOtp) {
      throw new BadRequestException('Verification code is required');
    }

    const storedOtp = this.passwordOtpCache.get(user.email.toLowerCase());
    if (!storedOtp || storedOtp.expiresAt < Date.now()) {
      throw new BadRequestException('Verification code has expired or is invalid. Please request a new code.');
    }

    if (storedOtp.code !== trimmedOtp) {
      throw new BadRequestException('Invalid verification code');
    }

    if (trimmedNewPassword.length < 6) {
      throw new BadRequestException('New password must be at least 6 characters');
    }

    const isCurrentPasswordValid = await this.verifyPassword(
      user.authId,
      user.email,
      trimmedCurrentPassword,
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
      throw new BadRequestException(error.message || 'Failed to update password');
    }

    // Clear used OTP
    this.passwordOtpCache.delete(user.email.toLowerCase());

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
        ...environmentCreateFields(user),
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

  private parseActivityLogDetails(details: unknown): Record<string, unknown> {
    if (!details) {
      return {};
    }

    if (typeof details === 'object' && details !== null) {
      return details as Record<string, unknown>;
    }

    if (typeof details !== 'string') {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(details);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
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
    query = query.eq('environment', getEnvironment(user));

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
    const typedLogs = (logs ?? []) as PasswordChangeLogRow[];
    const pendingLogs = typedLogs.filter((row) => {
      const details = this.parseActivityLogDetails(row.details);
      const requestStatus =
        typeof details.requestStatus === 'string'
          ? details.requestStatus.toLowerCase()
          : 'pending';
      const intendedApprover =
        typeof details.approverRole === 'string' ? details.approverRole : '';

      return (
        requestStatus === 'pending' &&
        intendedApprover === (approverRole as string)
      );
    });

    const requesterIds = Array.from(
      new Set(
        pendingLogs
          .map((row) => (typeof row.user_id === 'string' ? row.user_id : null))
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

    return pendingLogs.map((row) => {
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
    const logResult = await client
      .from('activity_logs')
      .select('id, user_id, branch_id, action, details, created_at')
      .eq('id', requestId)
      .eq('environment', getEnvironment(reviewer))
      .eq('action', 'PASSWORD_CHANGE_REQUEST')
      .maybeSingle();
    const logError = logResult.error;
    const logRow: PasswordChangeLogRow | null = logResult.data;

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

    if (!approverRole || approverRole !== (reviewer.role as string)) {
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
      .eq('id', requestId)
      .eq('environment', getEnvironment(reviewer));

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
        ...environmentCreateFields(reviewer),
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

  async forgotPassword(email: string) {
    const trimmedEmail = email?.trim().toLowerCase();
    if (!trimmedEmail) {
      throw new BadRequestException('Email address is required');
    }

    const user = await this.prisma.users.findFirst({
      where: { email: { equals: trimmedEmail, mode: 'insensitive' } },
      select: { id: true, auth_id: true, email: true, full_name: true },
    });

    if (!user) {
      return { message: 'If an account exists with this email, a verification code has been sent.' };
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    this.forgotPasswordOtpCache.set(trimmedEmail, {
      code: otpCode,
      expiresAt,
    });

    const userEmail = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = process.env.SMTP_SECURE !== 'false';
    const fromName = process.env.SMTP_FROM_NAME || 'QuickPawn';

    if (!userEmail || !pass) {
      this.logger.error('Email credentials not configured (GMAIL_USER or GMAIL_APP_PASSWORD missing)');
      throw new InternalServerErrorException('Email service is not configured');
    }

    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user: userEmail,
          pass,
        },
      });

      let decryptedName = 'User';
      if (user.full_name) {
        try {
          decryptedName = this.encryption.decryptUserFullName(user.full_name) || 'User';
        } catch {
          decryptedName = 'User';
        }
      }

      await transporter.sendMail({
        from: `"${fromName}" <${userEmail}>`,
        to: user.email,
        subject: `[${otpCode}] Password Reset Verification Code - QuickPawn`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
            <div style="text-align: center; padding-bottom: 16px; border-bottom: 2px solid #059669;">
              <h2 style="color: #059669; margin: 0; font-size: 22px;">QuickPawn Password Reset</h2>
            </div>
            <div style="padding: 20px 0; color: #374151; font-size: 14px; line-height: 1.6;">
              <p>Hello <strong>${decryptedName}</strong>,</p>
              <p>We received a request to reset your password for your QuickPawn account. Use the 6-digit verification code below to reset your password:</p>

              <div style="text-align: center; margin: 25px 0;">
                <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #059669; background-color: #ecfdf5; padding: 12px 28px; border-radius: 8px; border: 1px dashed #10b981;">
                  ${otpCode}
                </span>
              </div>

              <p style="font-size: 13px; color: #6b7280; text-align: center;">This code will expire in <strong>10 minutes</strong>.</p>
              <p style="font-size: 12px; color: #9ca3af; margin-top: 20px; text-align: center;">If you did not request a password reset, you can safely ignore this email.</p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Sent password reset OTP code to ${user.email}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send password reset OTP to ${user.email}: ${msg}`);
      throw new InternalServerErrorException('Failed to send verification code email');
    }

    return { message: 'Verification code sent to your email.' };
  }

  async resetPassword(email: string, otp: string, newPassword: string) {
    const trimmedEmail = email?.trim().toLowerCase();
    const trimmedOtp = otp?.trim();
    const trimmedPassword = newPassword?.trim();

    if (!trimmedEmail || !trimmedOtp || !trimmedPassword) {
      throw new BadRequestException('Email, OTP, and new password are required');
    }

    if (trimmedPassword.length < 6) {
      throw new BadRequestException('New password must be at least 6 characters');
    }

    const storedOtp = this.forgotPasswordOtpCache.get(trimmedEmail);
    if (!storedOtp || storedOtp.code !== trimmedOtp || Date.now() > storedOtp.expiresAt) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const user = await this.prisma.users.findFirst({
      where: { email: trimmedEmail },
      select: { id: true, auth_id: true, email: true },
    });

    if (!user || !user.auth_id) {
      throw new NotFoundException('User account not found');
    }

    const client = this.supabaseService.getClient();
    const { error } = await client.auth.admin.updateUserById(user.auth_id, {
      password: trimmedPassword,
    });

    if (error) {
      this.logger.error(`Failed to update password in Supabase for ${trimmedEmail}: ${error.message}`);
      throw new BadRequestException(error.message || 'Failed to update password in Supabase');
    }

    this.forgotPasswordOtpCache.delete(trimmedEmail);
    this.logger.log(`Successfully reset password via Supabase Auth for ${trimmedEmail}`);

    return { success: true, message: 'Password reset successfully. You can now log in with your new password.' };
  }
}
