import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreateBranchDto } from '../dto/create-branch.dto';
import { UpdateBranchDto } from '../dto/update-branch.dto';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import {
  inventoryLineValue,
  isStatusIncludedInInventoryValuation,
  type InventoryValuationMode,
} from '../../../common/utils/inventory-valuation.util';

@Injectable()
export class BranchesService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Restore plaintext contact_number after read; keeps API shape unchanged. */
  private mapBranchFromDb(row: Record<string, unknown> | null) {
    if (!row || typeof row !== 'object') return row;
    const contact = row.contact_number;
    return {
      ...row,
      contact_number:
        contact != null && contact !== ''
          ? this.encryption.decryptBranchContactNumber(String(contact))
          : contact,
    };
  }

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

  private resolveContactNumber(value?: string, fallback?: string): string {
    const candidate = value ?? fallback;
    if (!candidate) {
      throw new InternalServerErrorException(
        'Branch contact number is required',
      );
    }

    return candidate.trim();
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
    let payload = {
      name: this.normalizeBranchName(createBranchDto.name),
      branch_code: createBranchDto.branch_code.trim(),
      location: createBranchDto.location.trim(),
      contact_number: this.encryption.encryptBranchContactNumber(
        this.resolveContactNumber(
          createBranchDto.contact_number,
          createBranchDto.contactNumber,
        ),
      ),
      status: createBranchDto.status,
    };

    let { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .insert([payload])
      .select()
      .single();

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
        .select()
        .single();

      data = retryResult.data;
      error = retryResult.error;
    }

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return this.mapBranchFromDb(data as Record<string, unknown>);
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

    return (data ?? []).map((row: Record<string, unknown>) =>
      this.mapBranchFromDb(row),
    );
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

    return (data ?? []).map((row: Record<string, unknown>) =>
      this.mapBranchFromDb(row),
    );
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
      .eq('id', id)
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new NotFoundException('Branch not found');
    }

    return this.mapBranchFromDb(data as Record<string, unknown>);
  }

  async update(id: string, updateBranchDto: UpdateBranchDto) {
    const payload = {
      ...(updateBranchDto.name
        ? { name: this.normalizeBranchName(updateBranchDto.name) }
        : {}),
      ...(updateBranchDto.location
        ? { location: updateBranchDto.location.trim() }
        : {}),
      ...(updateBranchDto.contact_number || updateBranchDto.contactNumber
        ? {
            contact_number: this.encryption.encryptBranchContactNumber(
              this.resolveContactNumber(
                updateBranchDto.contact_number,
                updateBranchDto.contactNumber,
              ),
            ),
          }
        : {}),
      ...(updateBranchDto.status ? { status: updateBranchDto.status } : {}),
    };

    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return this.mapBranchFromDb(data as Record<string, unknown>);
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

  async getOverviewStats() {
    const client = this.supabaseService.getClient();

    const [branchesMeta, pawnedResult, saleResult] = await Promise.all([
      client.from('branches').select('id, inventory_valuation_mode'),
      client
        .from('pawned_items')
        .select(
          'branch_id, amount, status, appraised_value, estimated_resale_value',
        ),
      client.from('sale_items').select('branch_id, price, status'),
    ]);

    const modeByBranch = new Map<string, InventoryValuationMode>();
    for (const b of branchesMeta.data ?? []) {
      if (!b?.id) continue;
      modeByBranch.set(
        b.id,
        b.inventory_valuation_mode === 'APPRAISED_VALUE'
          ? 'APPRAISED_VALUE'
          : 'LOAN_AMOUNT',
      );
    }

    const branchStats = new Map<
      string,
      { pawnedItems: number; forSaleItems: number; totalValue: number }
    >();

    const ensure = (id: string) => {
      if (!branchStats.has(id)) {
        branchStats.set(id, { pawnedItems: 0, forSaleItems: 0, totalValue: 0 });
      }
      return branchStats.get(id)!;
    };

    // Pawn book value: Active + Expired (forfeited pipeline) + Inventory; per-branch LOAN_AMOUNT vs APPRAISED_VALUE.
    for (const item of pawnedResult.data ?? []) {
      if (!item.branch_id) continue;
      if (!isStatusIncludedInInventoryValuation(item.status as string)) continue;
      const s = ensure(item.branch_id);
      const mode = modeByBranch.get(item.branch_id) ?? 'LOAN_AMOUNT';
      const line = inventoryLineValue(
        {
          amount: item.amount,
          appraised_value: item.appraised_value,
          estimated_resale_value: item.estimated_resale_value,
        },
        mode,
      );
      s.pawnedItems += 1;
      s.totalValue += Number(line.toFixed(2));
    }

    for (const item of saleResult.data ?? []) {
      if (!item.branch_id) continue;
      const s = ensure(item.branch_id);
      if (item.status === 'Available') {
        s.forSaleItems += 1;
        s.totalValue += Number(item.price ?? 0);
      }
    }

    const result: Record<
      string,
      { pawnedItems: number; forSaleItems: number; totalValue: number }
    > = {};
    for (const [id, stats] of branchStats) {
      result[id] = stats;
    }

    return result;
  }
}
