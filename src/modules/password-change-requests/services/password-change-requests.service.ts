import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { Role } from '../../../common/enums';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { ActivatePasswordChangeRequestDto } from '../dto/activate-password-change-request.dto';
import { CreatePasswordChangeRequestDto } from '../dto/create-password-change-request.dto';
import {
  PasswordChangeRequestDecision,
  ReviewPasswordChangeRequestDto,
} from '../dto/review-password-change-request.dto';

interface UserRow {
  id: string;
  auth_id?: string | null;
  email?: string | null;
  full_name: string | null;
  role: string | null;
  branch_id: string | null;
  account_status?: string | null;
}

interface ActivityLogRow {
  id: string;
  user_id: string | null;
  branch_id: string | null;
  action: string;
  details: string | null;
  created_at: string;
}

type PasswordChangeRequestStatus = 'pending' | 'approved' | 'rejected';

interface PasswordChangeRequestRecord {
  id: string;
  requesterUserId: string;
  requesterAuthId: string | null;
  requesterEmail: string | null;
  requesterBranchId: string | null;
  requesterRole: string;
  targetRole: string;
  reason: string;
  status: PasswordChangeRequestStatus;
  isActivated: boolean;
  pendingPasswordEncrypted: string | null;
  reviewNote: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PasswordChangeRequestResponse extends PasswordChangeRequestRecord {
  requester: {
    id: string;
    fullName: string | null;
    role: string | null;
    branchId: string | null;
  } | null;
  reviewedBy: {
    id: string;
    fullName: string | null;
    role: string | null;
    branchId: string | null;
  } | null;
}

const PASSWORD_REQUEST_SUBMITTED = 'PASSWORD_CHANGE_REQUEST_SUBMITTED';
const PASSWORD_REQUEST_APPROVED = 'PASSWORD_CHANGE_REQUEST_APPROVED';
const PASSWORD_REQUEST_REJECTED = 'PASSWORD_CHANGE_REQUEST_REJECTED';
const PASSWORD_REQUEST_ACTIVATED = 'PASSWORD_CHANGE_REQUEST_ACTIVATED';

@Injectable()
export class PasswordChangeRequestsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly activityLogsService: ActivityLogsService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  private compactText(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private parseDetails(details: string | null): Record<string, unknown> {
    if (!details) return {};

    try {
      const parsed = JSON.parse(details) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private asStatus(value: unknown): PasswordChangeRequestStatus {
    if (value === 'approved' || value === 'rejected') return value;
    return 'pending';
  }

  private getPasswordSecret(): Buffer {
    const configuredSecret =
      this.configService.get<string>('passwordChange.secret') ||
      this.configService.get<string>('PASSWORD_CHANGE_SECRET') ||
      this.configService.get<string>('supabase.serviceRoleKey');

    if (!configuredSecret?.trim()) {
      throw new InternalServerErrorException(
        'Password change secret is not configured',
      );
    }

    return createHash('sha256').update(configuredSecret).digest();
  }

  private encryptPassword(password: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getPasswordSecret(), iv);
    const encrypted = Buffer.concat([
      cipher.update(password, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString(
      'base64',
    )}`;
  }

  private decryptPassword(payload: string): string {
    const [ivText, tagText, encryptedText] = payload.split(':');
    if (!ivText || !tagText || !encryptedText) {
      throw new InternalServerErrorException(
        'Stored password change request is invalid',
      );
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getPasswordSecret(),
        Buffer.from(ivText, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagText, 'base64'));

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64')),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch {
      throw new InternalServerErrorException(
        'Stored password change request could not be decrypted',
      );
    }
  }

  private async verifyActorPassword(
    actor: AuthenticatedUserProfile,
    password: string,
  ): Promise<void> {
    const authClient = this.supabaseService.getAuthClient();
    const { error } = await authClient.auth.signInWithPassword({
      email: actor.email,
      password,
    });

    if (error) {
      throw new UnauthorizedException('Invalid current password');
    }
  }

  private async loadRequestLogs(): Promise<ActivityLogRow[]> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('activity_logs')
      .select('id, user_id, branch_id, action, details, created_at')
      .in('action', [
        PASSWORD_REQUEST_SUBMITTED,
        PASSWORD_REQUEST_APPROVED,
        PASSWORD_REQUEST_REJECTED,
        PASSWORD_REQUEST_ACTIVATED,
      ])
      .order('created_at', { ascending: true })
      .limit(5000);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data ?? [];
  }

  private buildRecords(logs: ActivityLogRow[]): PasswordChangeRequestRecord[] {
    const records = new Map<string, PasswordChangeRequestRecord>();

    for (const log of logs) {
      const details = this.parseDetails(log.details);

      if (log.action === PASSWORD_REQUEST_SUBMITTED) {
        const requestId = this.asString(details.requestId) ?? log.id;
        const requesterUserId =
          this.asString(details.requesterUserId) ?? log.user_id;
        const requesterAuthId = this.asString(details.requesterAuthId);
        const requesterEmail = this.asString(details.requesterEmail);
        const requesterRole = this.asString(details.requesterRole);
        const targetRole = this.asString(details.targetRole);
        const reason = this.asString(details.reason);
        const pendingPasswordEncrypted = this.asString(
          details.pendingPasswordEncrypted,
        );
        const requesterBranchId =
          this.asString(details.requesterBranchId) ?? log.branch_id;

        if (!requesterUserId || !requesterRole || !targetRole || !reason) {
          continue;
        }

        records.set(requestId, {
          id: requestId,
          requesterUserId,
          requesterAuthId,
          requesterEmail,
          requesterBranchId,
          requesterRole,
          targetRole,
          reason,
          status: 'pending',
          isActivated: false,
          pendingPasswordEncrypted,
          reviewNote: null,
          reviewedByUserId: null,
          reviewedAt: null,
          createdAt: log.created_at,
          updatedAt: log.created_at,
        });
      }

      if (
        log.action === PASSWORD_REQUEST_APPROVED ||
        log.action === PASSWORD_REQUEST_REJECTED ||
        log.action === PASSWORD_REQUEST_ACTIVATED
      ) {
        const requestId = this.asString(details.requestId);
        if (!requestId) continue;

        const existing = records.get(requestId);
        if (!existing) continue;

        if (log.action === PASSWORD_REQUEST_ACTIVATED) {
          records.set(requestId, {
            ...existing,
            isActivated: true,
            pendingPasswordEncrypted: null,
            reviewNote:
              this.asString(details.note) ??
              existing.reviewNote ??
              'Password updated successfully.',
            updatedAt: log.created_at,
          });
          continue;
        }

        records.set(requestId, {
          ...existing,
          status: this.asStatus(
            details.decision ??
              (log.action === PASSWORD_REQUEST_APPROVED
                ? 'approved'
                : 'rejected'),
          ),
          pendingPasswordEncrypted:
            log.action === PASSWORD_REQUEST_APPROVED
              ? existing.pendingPasswordEncrypted
              : null,
          isActivated: false,
          reviewNote: this.asString(details.note),
          reviewedByUserId: log.user_id,
          reviewedAt: log.created_at,
          updatedAt: log.created_at,
        });
      }
    }

    return Array.from(records.values()).sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return a.id.localeCompare(b.id);
      }
      return a.createdAt > b.createdAt ? -1 : 1;
    });
  }

  private async loadUsersByIds(
    userIds: string[],
  ): Promise<Map<string, UserRow>> {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    const map = new Map<string, UserRow>();
    if (ids.length === 0) return map;

    const data = await this.prisma.users.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        auth_id: true,
        email: true,
        full_name: true,
        role: true,
        branch_id: true,
        account_status: true,
      },
    });

    for (const row of data as UserRow[]) {
      map.set(row.id, {
        ...row,
        full_name: this.encryption.decryptUserFullName(row.full_name),
      });
    }

    return map;
  }

  private mapRecord(
    record: PasswordChangeRequestRecord,
    usersById: Map<string, UserRow>,
  ): PasswordChangeRequestResponse {
    const requester = usersById.get(record.requesterUserId) ?? null;
    const reviewedBy = record.reviewedByUserId
      ? (usersById.get(record.reviewedByUserId) ?? null)
      : null;

    return {
      ...record,
      requester: requester
        ? {
            id: requester.id,
            fullName: requester.full_name,
            role: requester.role,
            branchId: requester.branch_id,
          }
        : null,
      reviewedBy: reviewedBy
        ? {
            id: reviewedBy.id,
            fullName: reviewedBy.full_name,
            role: reviewedBy.role,
            branchId: reviewedBy.branch_id,
          }
        : null,
    };
  }

  private async getApprovers(
    targetRole: Role.ADMIN | Role.SUPER_ADMIN,
    branchId: string | null,
  ): Promise<UserRow[]> {
    const data = await this.prisma.users.findMany({
      where: {
        role: targetRole,
        account_status: { not: 'rejected' },
        ...(targetRole === Role.ADMIN
          ? {
              branch_id: branchId,
            }
          : {}),
      },
      select: {
        id: true,
        full_name: true,
        role: true,
        branch_id: true,
        account_status: true,
      },
    });

    if (targetRole === Role.ADMIN && !branchId) {
      throw new BadRequestException(
        'Employee account must be assigned to a branch to request password change',
      );
    }

    return data
      .filter((row) => row.account_status !== 'pending')
      .map((row) => ({
        ...row,
        full_name: this.encryption.decryptUserFullName(row.full_name),
      }));
  }

  private toTargetRole(role: Role): Role.ADMIN | Role.SUPER_ADMIN {
    if (role === Role.EMPLOYEE) return Role.ADMIN;
    if (role === Role.ADMIN) return Role.SUPER_ADMIN;
    throw new ForbiddenException('Super admins do not need password approval');
  }

  private async resolveAuthUserId(
    record: PasswordChangeRequestRecord,
    requester: UserRow | null,
  ): Promise<string> {
    const client = this.supabaseService.getClient();
    const candidates = [
      record.requesterAuthId,
      requester?.auth_id ?? null,
      requester?.id ?? null,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      try {
        const result = await client.auth.admin.getUserById(candidate);
        if (result.data?.user?.id) {
          return result.data.user.id;
        }
      } catch {
        // Ignore candidate misses and continue to email lookup.
      }
    }

    const email = (record.requesterEmail ?? requester?.email ?? '')
      .trim()
      .toLowerCase();
    if (email) {
      const { data, error } = await client.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      const matched = data.users.find(
        (user) => (user.email ?? '').trim().toLowerCase() === email,
      );
      if (matched?.id) {
        return matched.id;
      }
    }

    throw new NotFoundException('Requester auth account could not be resolved');
  }

  async create(
    requester: AuthenticatedUserProfile,
    dto: CreatePasswordChangeRequestDto,
  ) {
    const reason = this.compactText(dto.reason);

    if (!reason) {
      throw new BadRequestException('Reason is required');
    }

    const targetRole = this.toTargetRole(requester.role);

    if (requester.role === Role.EMPLOYEE && !requester.branchId) {
      throw new BadRequestException(
        'Employee must be assigned to a branch to request password change',
      );
    }

    const logs = await this.loadRequestLogs();
    const records = this.buildRecords(logs);
    const hasPending = records.some(
      (record) =>
        record.requesterUserId === requester.id && record.status === 'pending',
    );

    if (hasPending) {
      throw new BadRequestException(
        'You already have a pending password change request',
      );
    }

    const approvers = await this.getApprovers(targetRole, requester.branchId);
    if (approvers.length === 0) {
      throw new BadRequestException(
        targetRole === Role.ADMIN
          ? 'No branch admin found for this branch'
          : 'No system admin found to review your request',
      );
    }

    const requestId = randomBytes(16).toString('hex');
    const now = new Date().toISOString();

    await this.activityLogsService.createLog({
      userId: requester.id,
      branchId: requester.branchId,
      action: PASSWORD_REQUEST_SUBMITTED,
      details: {
        requestId,
        requesterUserId: requester.id,
        requesterAuthId: requester.authId,
        requesterEmail: requester.email,
        requesterBranchId: requester.branchId,
        requesterRole: requester.role,
        targetRole,
        reason,
        status: 'pending',
      },
    });

    await Promise.all([
      this.notificationsService.create({
        title: 'Password Change Request Submitted',
        subtitle: `Your request was sent to ${targetRole === Role.ADMIN ? 'your branch admin' : 'system admin'} for approval.`,
        category: 'Requests',
        notification_type: 'PASSWORD_CHANGE_REQUEST',
        user_id: requester.id,
        branch_id: requester.branchId ?? undefined,
        event_key: `password-change:${requestId}:requester-submitted`,
        target_url: '/settings',
        entity_type: 'password_request',
        entity_id: requestId,
      }),
      ...approvers.map((approver) =>
        this.notificationsService.create({
          title: 'Password Change Request',
          subtitle: `${requester.fullName || requester.email} requested approval to change password.`,
          category: 'Requests',
          notification_type: 'PASSWORD_CHANGE_REQUEST',
          user_id: approver.id,
          branch_id: requester.branchId ?? undefined,
          event_key: `password-change:${requestId}:approver:${approver.id}`,
          target_url: '/settings',
          entity_type: 'password_request',
          entity_id: requestId,
        }),
      ),
    ]);

    const usersById = await this.loadUsersByIds([requester.id]);
    return this.mapRecord(
      {
        id: requestId,
        requesterUserId: requester.id,
        requesterAuthId: requester.authId,
        requesterEmail: requester.email,
        requesterBranchId: requester.branchId,
        requesterRole: requester.role,
        targetRole,
        reason,
        status: 'pending',
        isActivated: false,
        pendingPasswordEncrypted: null,
        reviewNote: null,
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      usersById,
    );
  }

  async findMine(user: AuthenticatedUserProfile) {
    const logs = await this.loadRequestLogs();
    const records = this.buildRecords(logs).filter(
      (record) => record.requesterUserId === user.id,
    );

    const usersById = await this.loadUsersByIds(
      records.flatMap(
        (record) =>
          [record.requesterUserId, record.reviewedByUserId].filter(
            Boolean,
          ) as string[],
      ),
    );

    return records.map((record) => ({
      ...this.mapRecord(record, usersById),
      pendingPasswordEncrypted: null,
    }));
  }

  async findPendingForReviewer(user: AuthenticatedUserProfile) {
    if (user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only approvers can view pending requests');
    }

    const logs = await this.loadRequestLogs();
    const records = this.buildRecords(logs)
      .filter((record) => record.status === 'pending')
      .filter((record) => record.targetRole === user.role)
      .filter((record) =>
        user.role === Role.ADMIN
          ? record.requesterBranchId === user.branchId
          : true,
      );

    const usersById = await this.loadUsersByIds(
      records.map((record) => record.requesterUserId),
    );

    return records.map((record) => ({
      ...this.mapRecord(record, usersById),
      pendingPasswordEncrypted: null,
    }));
  }

  async review(
    reviewer: AuthenticatedUserProfile,
    id: string,
    dto: ReviewPasswordChangeRequestDto,
  ) {
    if (reviewer.role !== Role.ADMIN && reviewer.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only approvers can review requests');
    }

    const logs = await this.loadRequestLogs();
    const existing = this.buildRecords(logs).find((record) => record.id === id);
    if (!existing) {
      throw new NotFoundException('Password change request not found');
    }

    if (existing.status !== 'pending') {
      throw new BadRequestException('Only pending requests can be reviewed');
    }

    if (existing.targetRole !== reviewer.role) {
      throw new ForbiddenException(
        'You are not allowed to review this request',
      );
    }

    if (
      reviewer.role === Role.ADMIN &&
      existing.requesterBranchId !== reviewer.branchId
    ) {
      throw new ForbiddenException(
        'You can only review requests from your branch',
      );
    }

    const note = this.compactText(dto.note);

    await this.activityLogsService.createLog({
      userId: reviewer.id,
      branchId: reviewer.branchId,
      action:
        dto.decision === PasswordChangeRequestDecision.APPROVED
          ? PASSWORD_REQUEST_APPROVED
          : PASSWORD_REQUEST_REJECTED,
      details: {
        requestId: existing.id,
        decision: dto.decision,
        note,
        requesterUserId: existing.requesterUserId,
        requesterBranchId: existing.requesterBranchId,
        targetRole: existing.targetRole,
      },
    });

    await this.notificationsService.create({
      title:
        dto.decision === PasswordChangeRequestDecision.APPROVED
          ? 'Password Change Request Approved'
          : 'Password Change Request Rejected',
      subtitle:
        dto.decision === PasswordChangeRequestDecision.APPROVED
          ? 'Your request has been approved. Log in with your current password and confirm the new password in Settings to activate it.'
          : `Your request was rejected${note ? `: ${note}` : '.'}`,
      category: 'Requests',
      notification_type: 'PASSWORD_CHANGE_REQUEST',
      user_id: existing.requesterUserId,
      branch_id: existing.requesterBranchId ?? undefined,
      event_key: `password-change:${existing.id}:review`,
      target_url: '/settings',
      entity_type: 'password_request',
      entity_id: existing.id,
    });

    const approvers = await this.getApprovers(
      existing.targetRole,
      existing.requesterBranchId,
    );

    await Promise.all(
      approvers.map((approver) =>
        this.notificationsService.create({
          title: 'Password Change Request Reviewed',
          subtitle: `A password change request was ${dto.decision}.`,
          category: 'Requests',
          notification_type: 'PASSWORD_CHANGE_REQUEST',
          user_id: approver.id,
          branch_id: existing.requesterBranchId ?? undefined,
          event_key: `password-change:${existing.id}:review-sync:${approver.id}`,
          target_url: '/settings',
          entity_type: 'password_request',
          entity_id: existing.id,
        }),
      ),
    );

    const usersById = await this.loadUsersByIds([
      existing.requesterUserId,
      reviewer.id,
    ]);

    return this.mapRecord(
      {
        ...existing,
        status: dto.decision,
        pendingPasswordEncrypted: null,
        reviewNote: note,
        reviewedByUserId: reviewer.id,
        reviewedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      usersById,
    );
  }

  async activate(
    user: AuthenticatedUserProfile,
    id: string,
    dto: ActivatePasswordChangeRequestDto,
  ) {
    const currentPassword = this.compactText(dto.currentPassword);
    const newPassword = this.compactText(dto.newPassword);

    if (!currentPassword) {
      throw new BadRequestException('Current password is required');
    }
    if (!newPassword) {
      throw new BadRequestException('New password is required');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }

    const logs = await this.loadRequestLogs();
    const existing = this.buildRecords(logs).find((record) => record.id === id);
    if (!existing || existing.requesterUserId !== user.id) {
      throw new NotFoundException('Password change request not found');
    }
    if (existing.status !== 'approved') {
      throw new BadRequestException(
        'Only approved password change requests can be activated',
      );
    }
    if (existing.isActivated) {
      throw new BadRequestException(
        'This password change approval has already been used',
      );
    }

    await this.verifyActorPassword(user, currentPassword);

    const usersById = await this.loadUsersByIds([existing.requesterUserId]);
    const requester = usersById.get(existing.requesterUserId) ?? null;
    const authUserId = await this.resolveAuthUserId(existing, requester);
    const client = this.supabaseService.getClient();
    const { error: authError } = await client.auth.admin.updateUserById(
      authUserId,
      { password: newPassword },
    );

    if (authError) {
      throw new InternalServerErrorException(authError.message);
    }

    const authClient = this.supabaseService.getAuthClient();
    const { data: refreshedSession, error: signInError } =
      await authClient.auth.signInWithPassword({
        email: user.email,
        password: newPassword,
      });

    if (signInError || !refreshedSession.session?.access_token) {
      throw new InternalServerErrorException(
        signInError?.message ||
          'Password was updated, but the session could not be refreshed',
      );
    }

    await this.activityLogsService.createLog({
      userId: user.id,
      branchId: user.branchId,
      action: PASSWORD_REQUEST_ACTIVATED,
      details: {
        requestId: existing.id,
        note: 'Password updated successfully.',
      },
    });

    await this.notificationsService.create({
      title: 'Password Change Activated',
      subtitle: 'Your one-time password change approval has been used.',
      category: 'Requests',
      notification_type: 'PASSWORD_CHANGE_REQUEST',
      user_id: user.id,
      branch_id: user.branchId ?? undefined,
      event_key: `password-change:${existing.id}:activated:${user.id}`,
      target_url: '/settings',
      entity_type: 'password_request',
      entity_id: existing.id,
    });

    return {
      success: true,
      message: 'Password saved successfully.',
      access_token: refreshedSession.session.access_token,
      expires_in: refreshedSession.session.expires_in,
    };
  }
}
