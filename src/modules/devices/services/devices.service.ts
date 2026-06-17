import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { Role } from '../../../common/enums';
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
  ) {}

  private decryptUserJoin<
    T extends { full_name?: string | null; email?: string | null } | null,
  >(user: T): T {
    return this.encryption.decryptUsersJoin(user) as T;
  }

  /** List all devices with employee + branch info + recent users. Super admin sees all; admin sees own branch only. */
  async findAll(actorRole: string, actorBranchId: string | null) {
    if (actorRole === Role.ADMIN && !actorBranchId) {
      throw new ForbiddenException('Branch scope is required');
    }

    const where =
      actorRole === Role.SUPER_ADMIN || actorRole === Role.ADMIN
        ? actorRole === Role.SUPER_ADMIN
          ? {}
          : {
              OR: [
                { branch_id: actorBranchId ?? undefined },
                { employee: { branch_id: actorBranchId ?? undefined } },
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
            },
            include: {
              employee: { select: { id: true, full_name: true, email: true, role: true } },
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

  async findOne(id: string) {
    const device = await this.prisma.authorized_devices.findUnique({
      where: { id },
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
  async authorize(dto: AuthorizeDeviceDto) {
    const employee = await this.prisma.users.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, role: true, branch_id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    const effectiveBranchId = dto.branchId ?? employee.branch_id ?? null;

    return this.prisma.authorized_devices.upsert({
      where: {
        employee_id_device_fingerprint: {
          employee_id: dto.employeeId,
          device_fingerprint: dto.deviceFingerprint,
        },
      },
      create: {
        employee_id: dto.employeeId,
        branch_id: effectiveBranchId,
        device_name: dto.deviceName,
        device_type: dto.deviceType ?? 'DESKTOP',
        device_fingerprint: dto.deviceFingerprint,
        ip_address: dto.ipAddress ?? null,
        status: 'AUTHORIZED',
      },
      update: {
        employee_id: dto.employeeId,
        status: 'AUTHORIZED',
        device_name: dto.deviceName,
        device_type: dto.deviceType ?? 'DESKTOP',
        branch_id: effectiveBranchId,
        updated_at: new Date(),
      },
    });
  }

  /** Employee self-requests authorization for their unknown device. Creates PENDING record.
   *  Can be called unauthenticated (employeeId = null) — employee email used to resolve their DB id. */
  async requestAuthorization(
    employeeId: string | null,
    dto: RequestAuthorizationDto,
    clientIp: string,
  ) {
    // Resolve employee id from email when called from the unauthenticated login screen
    let resolvedEmployeeId = employeeId;
    let resolvedBranchId: string | null = null;
    if (!resolvedEmployeeId && dto.email) {
      const user = await this.prisma.users.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
        select: { id: true, branch_id: true },
      });
      resolvedEmployeeId = user?.id ?? null;
      resolvedBranchId = user?.branch_id ?? null;
    }

    if (resolvedEmployeeId && !resolvedBranchId) {
      const user = await this.prisma.users.findUnique({
        where: { id: resolvedEmployeeId },
        select: { branch_id: true },
      });
      resolvedBranchId = user?.branch_id ?? null;
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
      },
    });

    if (existing) {
      if (existing.status === 'AUTHORIZED') {
        throw new BadRequestException('This device is already authorized for your account.');
      }
      if (existing.status === 'BLOCKED') {
        throw new ForbiddenException('Device is blocked');
      }
      return existing;
    }

    return this.prisma.authorized_devices.create({
      data: {
        employee_id: resolvedEmployeeId,
        branch_id: resolvedBranchId ?? undefined,
        device_name: dto.deviceName ?? 'Unknown Device',
        device_type: dto.deviceType ?? 'DESKTOP',
        device_fingerprint: dto.deviceFingerprint,
        ip_address: dto.ipAddress ?? clientIp,
        status: 'PENDING',
      },
    });
  }

  async update(id: string, dto: UpdateDeviceDto) {
    await this.findOne(id);
    return this.prisma.authorized_devices.update({
      where: { id },
      data: {
        ...dto,
        branch_id: dto.branchId,
        updated_at: new Date(),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.authorized_devices.delete({ where: { id } });
    return { success: true };
  }

  /** Block a device instantly (e.g. stolen). */
  async block(id: string) {
    await this.findOne(id);
    return this.prisma.authorized_devices.update({
      where: { id },
      data: { status: 'BLOCKED', updated_at: new Date() },
    });
  }

  /** All login log entries. Super admin sees all; admin sees own branch. */
  async findLogs(
    actorRole: string,
    actorBranchId: string | null,
    limit = 200,
  ) {
    if (actorRole !== Role.SUPER_ADMIN && actorRole !== Role.ADMIN) {
      throw new ForbiddenException('Access denied');
    }

    const branchFilter =
      actorRole === Role.ADMIN && actorBranchId
        ? { employee: { branch_id: actorBranchId } }
        : {};

    try {
      const logs = await this.prisma.login_logs.findMany({
        where: branchFilter,
        include: {
          employee: {
            select: { id: true, full_name: true, email: true, role: true, avatar_url: true },
          },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      });

      return logs.map((log) => ({
        ...log,
        employee: {
          ...this.decryptUserJoin(log.employee),
          avatarUrl: log.employee?.avatar_url ?? null,
        },
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
    deviceFingerprint: string,
    employeeId: string,
  ): Promise<{ authorized: boolean; reason?: string }> {
    const device = await this.prisma.authorized_devices.findFirst({
      where: {
        employee_id: employeeId,
        device_fingerprint: deviceFingerprint,
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
    deviceFingerprint?: string;
    ipAddress?: string;
    loginStatus: string;
    failureReason?: string;
  }) {
    try {
      await this.prisma.login_logs.create({
        data: {
          employee_id: data.employeeId ?? null,
          device_fingerprint: data.deviceFingerprint ?? null,
          ip_address: data.ipAddress ?? null,
          login_status: data.loginStatus,
          failure_reason: data.failureReason ?? null,
        },
      });
    } catch (err) {
      // Never let logging kill the main request
      this.logger.error('Failed to write login log', err);
    }
  }

}
