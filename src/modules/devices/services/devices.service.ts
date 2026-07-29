import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { NotificationsService } from '../../../modules/notifications/services/notifications.service';
import { Role } from '../../../common/enums';
import type { NotificationCreateInput } from '../../../modules/notifications/types/notification.types';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import {
  applyEnvironmentFilter,
  getEnvironment,
} from '../../../common/utils/authorization.util';
import { AuthorizeDeviceDto } from '../dto/authorize-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { RequestAuthorizationDto } from '../dto/request-authorization.dto';

// Login is allowed only for Super-Admin-approved (employee_id, device_fingerprint) pairs.

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private decryptUserJoin<
    T extends { full_name?: string | null; email?: string | null } | null,
  >(user: T): T {
    return this.encryption.decryptUsersJoin(user) as T;
  }

  /** List all devices with employee + branch info + recent users. Super admin sees all; admin sees own branch only. */
  async findAll(actor: AuthenticatedUserProfile) {
    if (actor.role === Role.ADMIN && !actor.branchId) {
      throw new ForbiddenException('Branch scope is required');
    }

    const where =
      actor.role === Role.SUPER_ADMIN || actor.role === Role.ADMIN
        ? actor.role === Role.SUPER_ADMIN
          ? applyEnvironmentFilter(actor)
          : {
              ...applyEnvironmentFilter(actor),
              OR: [
                { branch_id: actor.branchId ?? undefined },
                { employee: { branch_id: actor.branchId ?? undefined } },
              ],
            }
        : undefined;

    if (where === undefined) throw new ForbiddenException('Access denied');

    const devices = await this.prisma.authorized_devices.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            full_name: true,
            email: true,
            role: true,
            branch_id: true,
            branches: { select: { id: true, name: true } },
          },
        },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    // For each device, fetch distinct recent users who successfully logged in
    const enriched = await Promise.all(
      devices.map(async (device) => {
        let recentLogs: Array<{
          employee_id: string | null;
          created_at: Date;
          employee: {
            id: string;
            full_name: string | null;
            email: string | null;
            role: string;
          } | null;
        }> = [];

        try {
          recentLogs = await this.prisma.login_logs.findMany({
            where: {
              device_fingerprint: device.device_fingerprint,
              login_status: 'SUCCESS',
              employee_id: { not: null },
              environment: getEnvironment(actor),
            },
            include: {
              employee: {
                select: { id: true, full_name: true, email: true, role: true },
              },
            },
            orderBy: { created_at: 'desc' },
            take: 20,
          });
        } catch (error) {
          this.logger.warn(
            `Unable to load recent login users for device ${device.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        // Deduplicate by employee id, keep most recent per employee
        const seen = new Set<string>();
        const recentUsers = recentLogs
          .filter((log) => {
            if (!log.employee_id || seen.has(log.employee_id)) return false;
            seen.add(log.employee_id);
            return true;
          })
          .slice(0, 5)
          .map((log) => ({
            id: log.employee?.id,
            full_name: log.employee?.full_name,
            email: log.employee?.email,
            role: log.employee?.role,
            last_login: log.created_at,
          }));

        return {
          ...device,
          employee: this.decryptUserJoin(device.employee),
          branch: device.branch ?? device.employee?.branches ?? null,
          recent_users: recentUsers.map((user) => this.decryptUserJoin(user)),
        };
      }),
    );

    return enriched;
  }

  async findOne(actor: AuthenticatedUserProfile, id: string) {
    const device = await this.prisma.authorized_devices.findFirst({
      where: applyEnvironmentFilter(actor, { id }),
      include: {
        employee: {
          select: {
            id: true,
            full_name: true,
            email: true,
            role: true,
            branch_id: true,
            branches: { select: { id: true, name: true } },
          },
        },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!device) throw new NotFoundException('Device not found');
    return {
      ...device,
      employee: this.decryptUserJoin(device.employee),
      branch: device.branch ?? device.employee?.branches ?? null,
    };
  }

  /** Called by super admin to authorize a pending/unknown device. */
  async authorize(actor: AuthenticatedUserProfile, dto: AuthorizeDeviceDto) {
    const employee = await this.prisma.users.findFirst({
      where: applyEnvironmentFilter(actor, { id: dto.employeeId }),
      select: { id: true, role: true, branch_id: true, auth_id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    const effectiveBranchId = dto.branchId ?? employee.branch_id ?? null;

    const existing = await this.prisma.authorized_devices.findFirst({
      where: {
        employee_id: dto.employeeId,
        device_fingerprint: dto.deviceFingerprint,
        environment: getEnvironment(actor),
      },
    });

    if (existing) {
      return this.prisma.authorized_devices.update({
        where: { id: existing.id },
        data: {
          employee_id: dto.employeeId,
          status: 'AUTHORIZED',
          device_name: dto.deviceName,
          device_type: dto.deviceType ?? 'DESKTOP',
          branch_id: effectiveBranchId,
          ip_address: dto.ipAddress ?? existing.ip_address,
          updated_at: new Date(),
          environment: getEnvironment(actor),
          created_by: existing.created_by ?? actor.authId,
        },
      });
    }

    return this.prisma.authorized_devices.create({
      data: {
        employee_id: dto.employeeId,
        branch_id: effectiveBranchId,
        device_name: dto.deviceName,
        device_type: dto.deviceType ?? 'DESKTOP',
        device_fingerprint: dto.deviceFingerprint,
        ip_address: dto.ipAddress ?? null,
        status: 'AUTHORIZED',
        environment: getEnvironment(actor),
        created_by: actor.authId,
      },
    });
  }

  /** Employee self-requests authorization for their unknown device. Creates PENDING record.
   *  Can be called unauthenticated (employeeId = null) — employee email used to resolve their DB id.
   *  `knownEnvironment`, when provided, is used as-is instead of being re-derived from the DB —
   *  callers that already computed the login-time environment (e.g. the auto-request triggered
   *  from `AuthService.loginInternal`) must pass it through so the request lands in the same
   *  environment bucket the login attempt itself was evaluated against. */
  async requestAuthorization(
    employeeId: string | null,
    dto: RequestAuthorizationDto,
    clientIp: string,
    knownEnvironment?: 'production' | 'development',
  ) {
    // Resolve employee id from email when called from the unauthenticated login screen
    let resolvedEmployeeId = employeeId;
    let resolvedBranchId: string | null = null;
    let resolvedAuthId: string | null = null;
    let resolvedEnvironment: 'production' | 'development' =
      knownEnvironment ?? 'production';
    if (!resolvedEmployeeId && dto.email) {
      const user = await this.prisma.users.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
        select: {
          id: true,
          auth_id: true,
          branch_id: true,
          email: true,
          is_developer: true,
        },
      });
      resolvedEmployeeId = user?.id ?? null;
      resolvedBranchId = user?.branch_id ?? null;
      resolvedAuthId = user?.auth_id ?? null;
      resolvedEnvironment =
        knownEnvironment ??
        (user
          ? getEnvironment({
              email: user.email,
              isDeveloper: user.is_developer,
            })
          : 'production');
    }

    if (resolvedEmployeeId && !resolvedBranchId) {
      const user = await this.prisma.users.findUnique({
        where: { id: resolvedEmployeeId },
        select: {
          auth_id: true,
          branch_id: true,
          email: true,
          is_developer: true,
        },
      });
      resolvedBranchId = user?.branch_id ?? null;
      resolvedAuthId = user?.auth_id ?? null;
      resolvedEnvironment =
        knownEnvironment ??
        (user
          ? getEnvironment({
              email: user.email,
              isDeveloper: user.is_developer,
            })
          : resolvedEnvironment);
    }

    if (!resolvedEmployeeId) {
      throw new BadRequestException(
        'A valid employee email is required to request device authorization.',
      );
    }

    const existing = await this.prisma.authorized_devices.findFirst({
      where: {
        employee_id: resolvedEmployeeId,
        device_fingerprint: dto.deviceFingerprint,
        environment: resolvedEnvironment,
      },
    });

    if (existing) {
      if (existing.status === 'AUTHORIZED') {
        throw new BadRequestException(
          'This device is already authorized for your account.',
        );
      }
      if (existing.status === 'BLOCKED') {
        throw new ForbiddenException('Device is blocked');
      }
      return existing;
    }

    const blockedFingerprint = await this.prisma.authorized_devices.findFirst({
      where: {
        device_fingerprint: dto.deviceFingerprint,
        environment: resolvedEnvironment,
        status: 'BLOCKED',
      },
      orderBy: { created_at: 'desc' },
    });

    if (blockedFingerprint) {
      throw new ForbiddenException('Device is blocked');
    }

    const device = await this.prisma.authorized_devices.create({
      data: {
        employee_id: resolvedEmployeeId,
        branch_id: resolvedBranchId ?? undefined,
        device_name: dto.deviceName ?? 'Unknown Device',
        device_type: dto.deviceType ?? 'DESKTOP',
        device_fingerprint: dto.deviceFingerprint,
        ip_address: dto.ipAddress ?? clientIp,
        status: 'PENDING',
        environment: resolvedEnvironment,
        created_by: resolvedAuthId,
      },
    });

    // Fire notification asynchronously (non-blocking)
    // employee_id is guaranteed to be non-null here because we validated resolvedEmployeeId above
    if (device.employee_id) {
      this.notifyDeviceAuthorizationRequest(
        device.id,
        device.device_fingerprint,
        device.device_name,
        device.device_type,
        device.ip_address,
        device.employee_id,
        device.branch_id,
        device.environment as 'production' | 'development',
      ).catch(() => {
        // Error already logged in notifyDeviceAuthorizationRequest
      });
    }

    return device;
  }

  async update(
    actor: AuthenticatedUserProfile,
    id: string,
    dto: UpdateDeviceDto,
  ) {
    await this.findOne(actor, id);
    return this.prisma.authorized_devices.update({
      where: { id },
      data: {
        ...dto,
        branch_id: dto.branchId,
        updated_at: new Date(),
      },
    });
  }

  async remove(actor: AuthenticatedUserProfile, id: string) {
    await this.findOne(actor, id);
    await this.prisma.authorized_devices.delete({ where: { id } });
    return { success: true };
  }

  /** Block a device instantly (e.g. stolen). */
  async block(actor: AuthenticatedUserProfile, id: string) {
    await this.findOne(actor, id);
    return this.prisma.authorized_devices.update({
      where: { id },
      data: { status: 'BLOCKED', updated_at: new Date() },
    });
  }

  /** All login log entries. Super admin sees all; admin sees own branch. */
  async findLogs(actor: AuthenticatedUserProfile, limit = 200) {
    if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Access denied');
    }

    const branchFilter =
      actor.role === Role.ADMIN && actor.branchId
        ? { employee: { branch_id: actor.branchId } }
        : {};

    try {
      const logs = await this.prisma.login_logs.findMany({
        where: applyEnvironmentFilter(actor, branchFilter),
        include: {
          employee: {
            select: {
              id: true,
              full_name: true,
              email: true,
              role: true,
              avatar_url: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      });

      return logs.map((log) => ({
        ...log,
        employee: log.employee
          ? {
              ...this.decryptUserJoin(log.employee),
              avatarUrl: log.employee.avatar_url ?? null,
            }
          : null,
      }));
    } catch (error) {
      this.logger.warn(
        `Unable to load login logs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** Validate that this employee is authorized on this specific device fingerprint. */
  async validateAndUpdateLastLogin(
    user: AuthenticatedUserProfile,
    deviceFingerprint: string,
  ): Promise<{ authorized: boolean; reason?: string }> {
    const device = await this.prisma.authorized_devices.findFirst({
      where: {
        employee_id: user.id,
        device_fingerprint: deviceFingerprint,
        environment: getEnvironment(user),
      },
    });

    if (!device) {
      return { authorized: false, reason: 'UNKNOWN_DEVICE' };
    }

    if (device.status === 'BLOCKED') {
      return { authorized: false, reason: 'DEVICE_BLOCKED' };
    }

    if (device.status === 'PENDING') {
      return { authorized: false, reason: 'DEVICE_PENDING' };
    }

    if (device.status !== 'AUTHORIZED') {
      return { authorized: false, reason: 'UNKNOWN_DEVICE' };
    }

    await this.prisma.authorized_devices.update({
      where: { id: device.id },
      data: { last_login: new Date(), updated_at: new Date() },
    });

    return { authorized: true };
  }

  /** Write a login log entry. */
  async writeLoginLog(data: {
    employeeId?: string;
    authId?: string;
    deviceFingerprint?: string;
    ipAddress?: string;
    loginStatus: string;
    failureReason?: string;
    environment?: 'production' | 'development';
  }) {
    try {
      await this.prisma.login_logs.create({
        data: {
          employee_id: data.employeeId ?? null,
          device_fingerprint: data.deviceFingerprint ?? null,
          ip_address: data.ipAddress ?? null,
          login_status: data.loginStatus,
          failure_reason: data.failureReason ?? null,
          environment: data.environment ?? 'production',
          created_by: data.authId ?? null,
        },
      });
    } catch (err) {
      // Never let logging kill the main request
      this.logger.error('Failed to write login log', err);
    }
  }

  /** Create device authorization notification for super admins (fire-and-forget pattern). */
  private async notifyDeviceAuthorizationRequest(
    deviceId: string,
    deviceFingerprint: string,
    deviceName: string,
    deviceType: string,
    ipAddress: string | null,
    employeeId: string,
    branchId: string | null,
    environment: 'production' | 'development',
  ): Promise<void> {
    try {
      // Fetch employee details for notification context
      const employee = await this.prisma.users.findUnique({
        where: { id: employeeId },
        select: {
          id: true,
          full_name: true,
          email: true,
          branch_id: true,
        },
      });

      if (!employee) {
        this.logger.warn(
          `Cannot create device auth notification: employee ${employeeId} not found`,
        );
        return;
      }

      // Build notification message
      const messageParts = [
        `Device: ${deviceName} (${deviceType})`,
        `Requested by: ${employee.full_name} (${employee.email})`,
      ];

      if (ipAddress) {
        messageParts.push(`IP Address: ${ipAddress}`);
      }

      const message = messageParts.join('\n');

      // Create notification payload
      const payload: NotificationCreateInput = {
        title: `Device Authorization Request from ${employee.full_name}`,
        message,
        category: 'Requests',
        entity_type: 'system',
        entity_id: deviceId,
        event_key: `device_auth_request:${deviceId}`,
        target_role: Role.SUPER_ADMIN,
        user_id: null,
        branch_id: branchId,
        environment,
      };

      // Create notification (non-blocking)
      await this.notificationsService.create(payload);
    } catch (error) {
      // Log error but don't propagate - notification failure should not block authorization
      this.logger.error(
        `Failed to create device authorization notification for device ${deviceId}, employee ${employeeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
