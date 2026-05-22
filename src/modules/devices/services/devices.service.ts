import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { Role } from '../../../common/enums';
import { AuthorizeDeviceDto } from '../dto/authorize-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { RequestAuthorizationDto } from '../dto/request-authorization.dto';

const DEVICE_LIMITS: Record<string, number> = {
  [Role.SUPER_ADMIN]: Infinity,
  [Role.ADMIN]: Infinity,
  [Role.EMPLOYEE]: 2,
};

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** List all devices with employee + branch info. Super admin sees all; admin sees own branch only. */
  async findAll(actorRole: string, actorBranchId: string | null) {
    const where =
      actorRole === Role.SUPER_ADMIN || actorRole === Role.ADMIN
        ? actorRole === Role.SUPER_ADMIN
          ? {}
          : { branch_id: actorBranchId ?? undefined }
        : undefined;

    if (where === undefined) throw new ForbiddenException('Access denied');

    return this.prisma.authorized_devices.findMany({
      where,
      include: {
        employee: { select: { id: true, full_name: true, email: true, role: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async findOne(id: string) {
    const device = await this.prisma.authorized_devices.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, full_name: true, email: true, role: true } },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }

  /** Called by super admin to authorize a pending/unknown device. */
  async authorize(dto: AuthorizeDeviceDto) {
    const employee = await this.prisma.users.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, role: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    await this.enforceDeviceLimit(dto.employeeId, employee.role);

    return this.prisma.authorized_devices.upsert({
      where: { device_fingerprint: dto.deviceFingerprint },
      create: {
        employee_id: dto.employeeId,
        branch_id: dto.branchId ?? null,
        device_name: dto.deviceName,
        device_type: dto.deviceType ?? 'DESKTOP',
        device_fingerprint: dto.deviceFingerprint,
        ip_address: dto.ipAddress ?? null,
        status: 'AUTHORIZED',
      },
      update: {
        status: 'AUTHORIZED',
        device_name: dto.deviceName,
        device_type: dto.deviceType ?? 'DESKTOP',
        branch_id: dto.branchId ?? null,
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
    if (!resolvedEmployeeId && dto.email) {
      const user = await this.prisma.users.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
        select: { id: true },
      });
      resolvedEmployeeId = user?.id ?? null;
    }

    const existing = await this.prisma.authorized_devices.findUnique({
      where: { device_fingerprint: dto.deviceFingerprint },
    });

    if (existing) {
      if (existing.status === 'AUTHORIZED')
        throw new BadRequestException('Device is already authorized');
      if (existing.status === 'BLOCKED')
        throw new ForbiddenException('Device is blocked');
      // Already pending — idempotent
      return existing;
    }

    return this.prisma.authorized_devices.create({
      data: {
        employee_id: resolvedEmployeeId ?? undefined,
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

    return this.prisma.login_logs.findMany({
      where: branchFilter,
      include: {
        employee: {
          select: { id: true, full_name: true, email: true, role: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  /** Validate device fingerprint during login and update last_login timestamp. */
  async validateAndUpdateLastLogin(
    deviceFingerprint: string,
    employeeId: string,
  ): Promise<{ authorized: boolean; reason?: string }> {
    const device = await this.prisma.authorized_devices.findUnique({
      where: { device_fingerprint: deviceFingerprint },
    });

    if (!device) return { authorized: false, reason: 'UNKNOWN_DEVICE' };
    if (device.status === 'BLOCKED') return { authorized: false, reason: 'DEVICE_BLOCKED' };
    if (device.status === 'PENDING') return { authorized: false, reason: 'DEVICE_PENDING' };
    if (device.employee_id !== employeeId)
      return { authorized: false, reason: 'DEVICE_EMPLOYEE_MISMATCH' };

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

  private async enforceDeviceLimit(employeeId: string, role: string) {
    const limit = DEVICE_LIMITS[role] ?? 2;
    if (!isFinite(limit)) return;

    const count = await this.prisma.authorized_devices.count({
      where: { employee_id: employeeId, status: 'AUTHORIZED' },
    });

    if (count >= limit) {
      throw new BadRequestException(
        `Device limit reached (max ${limit} for role ${role})`,
      );
    }
  }
}
