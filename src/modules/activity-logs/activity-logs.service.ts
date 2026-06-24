import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma';
import { SupabaseService } from '../../infrastructure/supabase/supabase.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import {
  type DataEnvironment,
  getEnvironment,
} from '../../common/utils/authorization.util';

export interface CreateActivityLogDto {
  userId: string;
  authId?: string | null;
  environment?: DataEnvironment;
  branchId?: string | null;
  action: string;
  details?: string | Record<string, any> | null;
}

function toManilaDayBoundary(value: string, endOfDay: boolean): string {
  const datePart = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return value;

  return endOfDay
    ? `${datePart}T23:59:59.999+08:00`
    : `${datePart}T00:00:00.000+08:00`;
}

@Injectable()
export class ActivityLogsService {
  private readonly logger = new Logger(ActivityLogsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async createLog(dto: CreateActivityLogDto) {
    const client = this.supabaseService.getClient();
    let environment = dto.environment;
    let createdBy = dto.authId ?? null;

    if (!environment || !createdBy) {
      const actor = await this.prisma.users.findUnique({
        where: { id: dto.userId },
        select: { auth_id: true, email: true, is_developer: true },
      });
      environment ??= actor
        ? getEnvironment({
            email: actor.email,
            isDeveloper: actor.is_developer,
          })
        : 'production';
      createdBy ??= actor?.auth_id ?? null;
    }

    // We do this silently to not interrupt main business flows
    const { error } = await client.from('activity_logs').insert({
      user_id: dto.userId,
      branch_id: dto.branchId || null,
      action: dto.action,
      environment,
      created_by: createdBy,
      details: dto.details
        ? typeof dto.details === 'string'
          ? dto.details
          : JSON.stringify(dto.details)
        : null,
    });

    if (error) {
      this.logger.error(`Failed to insert activity log: ${error.message}`);
    }
  }

  async getLogs(
    viewer: AuthenticatedUserProfile,
    branchId?: string,
    role?: string,
    startDate?: string,
    endDate?: string,
    action?: string,
    pawnedItemId?: string,
    userId?: string,
  ) {
    try {
      const where: any = { environment: getEnvironment(viewer) };

      if (role === 'admin' || role === 'employee' || role === 'branch') {
        if (!branchId) {
          throw new InternalServerErrorException(
            'Branch ID is required for non-superadmin logs',
          );
        }
        where.branch_id = branchId;
        if (role === 'employee' || role === 'branch') {
          if (!userId) {
            throw new InternalServerErrorException(
              'User ID is required for employee logs',
            );
          }
          where.user_id = userId;
        }
      } else if (branchId) {
        where.branch_id = branchId;
      }

      if (startDate) {
        where.created_at = { ...(where.created_at || {}), gte: toManilaDayBoundary(startDate, false) };
      }

      if (endDate) {
        where.created_at = { ...(where.created_at || {}), lte: toManilaDayBoundary(endDate, true) };
      }

      if (action) {
        where.action = action.includes(',') ? { in: action.split(',') } : action;
      }

      if (pawnedItemId) {
        where.details = { contains: pawnedItemId, mode: 'insensitive' };
      }

      const logs = await this.prisma.activity_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: {
          users: { select: { full_name: true, email: true, role: true, avatar_url: true } },
          branches: { select: { name: true } },
        },
      });

      return logs.map((log) => {
        const usersJoin = this.encryption.decryptUsersJoin(log.users);
        return {
          id: log.id,
          userId: log.user_id,
          branchId: log.branch_id,
          action: log.action,
          details: log.details,
          createdAt: log.created_at,
          userFullName:
            usersJoin?.full_name || usersJoin?.email || 'Unknown User',
          userRole: log.users?.role || 'Unknown Role',
          userAvatarUrl: log.users?.avatar_url ?? null,
          branchName: log.branches?.name || 'All Branches',
        };
      });
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to fetch logs: ${message}`);
      throw new InternalServerErrorException('Failed to fetch activity logs');
    }
  }
}
