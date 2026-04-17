import { Injectable, InternalServerErrorException } from '@nestjs/common';
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
}
