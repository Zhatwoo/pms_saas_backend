import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import { Role } from '../../../common/enums';
import { CreateCustomerDto } from '../dto/create-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly supabase: SupabaseService) {}

  async create(user: UserWithBranch, dto: CreateCustomerDto) {
    const client = this.supabase.getClient();
    const payload =
      user.role === Role.SUPER_ADMIN
        ? { ...dto }
        : {
            ...dto,
            branch_id: requireUserBranchId(user),
          };

    const { data, error } = await client
      .from('customers')
      .insert([payload])
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async findAll(user: UserWithBranch, branchId?: string) {
    const client = this.supabase.getClient();
    let query = client
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false });

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    } else if (branchId) {
      query = query.eq('branch_id', branchId);
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async findOne(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    let query = client.from('customers').select('*').eq('id', id);

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    }

    const { data, error } = await query.single();
    if (error) {
      if (
        error.code === 'PGRST116' ||
        error.code === '22P02' ||
        error.message?.toLowerCase().includes('invalid input syntax')
      ) {
        return null;
      }

      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async findCustomerActivityLogs(user: UserWithBranch, customerId: string) {
    const client = this.supabase.getClient();
    const customer = await this.findOne(user, customerId);

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    let query = client
      .from('activity_logs')
      .select('id, action, details, created_at, users(full_name, email)')
      .order('created_at', { ascending: false });

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    } else if (customer.branch_id) {
      query = query.eq('branch_id', customer.branch_id);
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const customerLogs = (data || [])
      .map((log: any) => {
        const rawDetails = typeof log.details === 'string' ? log.details : '';

        let parsedDetails: Record<string, unknown> = {};
        if (rawDetails) {
          try {
            parsedDetails = JSON.parse(rawDetails) as Record<string, unknown>;
          } catch {
            parsedDetails = {};
          }
        }

        const detailsCustomerId =
          typeof parsedDetails.customerId === 'string'
            ? parsedDetails.customerId
            : typeof parsedDetails.customer_id === 'string'
              ? parsedDetails.customer_id
              : null;

        if (detailsCustomerId !== customerId) {
          return null;
        }

        return {
          id: log.id,
          action: log.action,
          details: parsedDetails,
          createdAt: log.created_at,
          actorName: log.users?.full_name || log.users?.email || 'System',
        };
      })
      .filter(Boolean);

    return customerLogs;
  }

  async addCustomerNote(
    user: UserWithBranch & { id: string },
    customerId: string,
    title?: string,
    note?: string,
  ) {
    const client = this.supabase.getClient();
    const customer = await this.findOne(user, customerId);

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const trimmedNote = note?.trim() ?? '';
    if (!trimmedNote) {
      throw new BadRequestException('Note is required');
    }

    const trimmedTitle = title?.trim() || 'Manual Note';

    const { error } = await client.from('activity_logs').insert({
      user_id: user.id,
      branch_id: customer.branch_id || null,
      action: 'CUSTOMER_NOTE_ADDED',
      details: JSON.stringify({
        customerId,
        title: trimmedTitle,
        note: trimmedNote,
      }),
    });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { message: 'Note saved successfully' };
  }
}
