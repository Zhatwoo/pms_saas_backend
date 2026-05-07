import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../infrastructure/supabase/supabase.service';
import { EncryptionService } from '../../common/encryption/encryption.service';

export interface CreateActivityLogDto {
  userId: string;
  branchId?: string | null;
  action: string;
  details?: string | Record<string, any> | null;
}

@Injectable()
export class ActivityLogsService {
  private readonly logger = new Logger(ActivityLogsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly encryption: EncryptionService,
  ) {}

  async createLog(dto: CreateActivityLogDto) {
    const client = this.supabaseService.getClient();

    // We do this silently to not interrupt main business flows
    const { error } = await client.from('activity_logs').insert({
      user_id: dto.userId,
      branch_id: dto.branchId || null,
      action: dto.action,
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
    branchId?: string,
    role?: string,
    startDate?: string,
    endDate?: string,
    action?: string,
    pawnedItemId?: string,
  ) {
    const client = this.supabaseService.getClient();
    let query = client
      .from('activity_logs')
      .select(
        `
        id,
        user_id,
        branch_id,
        action,
        details,
        created_at,
        users ( full_name, email, role ),
        branches ( name )
      `,
      )
      .order('created_at', { ascending: false });

    if (role === 'admin' || role === 'employee' || role === 'branch') {
      if (!branchId) {
        throw new InternalServerErrorException(
          'Branch ID is required for non-superadmin logs',
        );
      }
      query = query.eq('branch_id', branchId);
    } else if (branchId) {
      // Super admin filtering by branch
      query = query.eq('branch_id', branchId);
    }

    if (startDate) {
      // Use ISO format to ensure correct comparison
      query = query.gte('created_at', `${startDate}T00:00:00.000Z`);
    }

    if (endDate) {
      query = query.lte('created_at', `${endDate}T23:59:59.999Z`);
    }

    if (action) {
      if (action.includes(',')) {
        query = query.in('action', action.split(','));
      } else {
        query = query.eq('action', action);
      }
    }

    if (pawnedItemId) {
      query = query.ilike('details', `%${pawnedItemId}%`);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch logs: ${error.message}`);
      throw new InternalServerErrorException('Failed to fetch activity logs');
    }

    return (data || []).map((log: any) => {
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
        branchName: log.branches?.name || 'All Branches',
      };
    });
  }
}
