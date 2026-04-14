import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { CreateBranchDto } from '../dto/create-branch.dto';
import { UpdateBranchDto } from '../dto/update-branch.dto';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';

@Injectable()
export class BranchesService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private toTitleCase(value: string): string {
    return value
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private normalizeBranchName(rawName: string): string {
    const trimmed = rawName.trim();
    const withoutSuffix = trimmed.replace(/\s*branch\s*$/i, '');
    const normalizedBase = this.toTitleCase(withoutSuffix);
    return `${normalizedBase} Branch`;
  }

  private async getNextAvailableBranchCode(): Promise<string> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('branch_code');

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const usedCodes = new Set(
      (data ?? []).map((row: { branch_code: string }) => row.branch_code),
    );

    for (let i = 1; i <= 9999; i++) {
      const candidate = String(i).padStart(3, '0');
      if (!usedCodes.has(candidate)) {
        return candidate;
      }
    }

    throw new InternalServerErrorException('No available branch code slots');
  }

  async create(createBranchDto: CreateBranchDto) {
    let payload: CreateBranchDto = {
      ...createBranchDto,
      name: this.normalizeBranchName(createBranchDto.name),
      branch_code: createBranchDto.branch_code.trim(),
    };

    let { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .insert([payload])
      .select();

    const created = data?.[0];

    // If client-side generated code is stale, retry once using the next free code.
    if (error?.code === '23505' || /branch_code/i.test(error?.message ?? '')) {
      payload = {
        ...payload,
        branch_code: await this.getNextAvailableBranchCode(),
      };

      const retryResult = await this.supabaseService
        .getClient()
        .from('branches')
        .insert([payload])
        .select();

      data = retryResult.data;
      error = retryResult.error;
    }

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data?.[0];
  }

  async findAll() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  /** Admin / employee: only their assigned branch. Super admin: all. */
  async findAllForActor(user: UserWithBranch) {
    if (user.role === Role.SUPER_ADMIN) {
      return this.findAll();
    }
    const branchId = requireUserBranchId(user);
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('*')
      .eq('id', branchId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data ?? [];
  }

  /** Public signup: active branches only (id + name). */
  async findActiveSummaries() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('id, name')
      .eq('status', 'Active')
      .order('name', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (data ?? []).map((row: { id: string; name: string }) => ({
      id: row.id,
      name: row.name,
    }));
  }

  async findOne(id: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('*')
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data || data.length === 0) {
      return null;
    }

    return data[0];
  }

  async update(id: string, updateBranchDto: UpdateBranchDto) {
    const payload: UpdateBranchDto = {
      ...updateBranchDto,
      ...(updateBranchDto.name
        ? { name: this.normalizeBranchName(updateBranchDto.name) }
        : {}),
    };

    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .update(payload)
      .eq('id', id)
      .select();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data?.[0];
  }

  async remove(id: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('branches')
      .delete()
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { deleted: true };
  }
}

