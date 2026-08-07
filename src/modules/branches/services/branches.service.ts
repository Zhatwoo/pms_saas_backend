import {
  Injectable,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
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
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  applyEnvironmentFilter,
  environmentCreateFields,
  getEnvironment,
} from '../../../common/utils/authorization.util';

@Injectable()
export class BranchesService {
  private readonly logger = new Logger(BranchesService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Fields needed by the branch picker and actor-scoped list route.
   * Narrow select avoids unrelated columns and keeps JSON payloads predictable.
   */
  private readonly branchCardSelect = {
    id: true,
    branch_code: true,
    name: true,
    location: true,
    contact_number: true,
    status: true,
    maintaining_balance: true,
    environment: true,
  } as const;

  /** Narrow Supabase error shape — keeps eslint strict mode happy vs `single()` payloads. */
  private static unwrapSupabaseRow(resp: unknown): {
    data: Record<string, unknown> | null;
    error: { message: string; code?: string } | null;
  } {
    if (!resp || typeof resp !== 'object') {
      return { data: null, error: { message: 'Invalid Supabase response' } };
    }
    const r = resp as {
      data?: unknown;
      error?: { message: string; code?: string } | null;
    };
    return {
      data:
        r.data != null && typeof r.data === 'object' && !Array.isArray(r.data)
          ? (r.data as Record<string, unknown>)
          : null,
      error: r.error ?? null,
    };
  }

  /** Restore plaintext contact_number after read; keeps API shape unchanged. */
  private mapBranchFromDb(row: Record<string, unknown> | null) {
    if (!row || typeof row !== 'object') return row;
    const raw = row.contact_number;

    let contact_number: unknown = raw;
    if (typeof raw === 'string') {
      contact_number =
        raw.trim() !== ''
          ? this.encryption.decryptBranchContactNumber(raw)
          : raw;
    } else if (raw === undefined) {
      contact_number = null;
    }

    return {
      ...row,
      contact_number,
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
    const rows = await this.prisma.branches.findMany({
      select: { branch_code: true },
    });

    const usedCodes = new Set(rows.map((row) => row.branch_code));

    for (let i = 1; i <= 9999; i++) {
      const candidate = String(i).padStart(3, '0');
      if (!usedCodes.has(candidate)) {
        return candidate;
      }
    }

    throw new InternalServerErrorException('No available branch code slots');
  }

  async create(createBranchDto: CreateBranchDto, user: UserWithBranch) {
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
      ...(createBranchDto.maintaining_balance !== undefined
        ? { maintaining_balance: createBranchDto.maintaining_balance }
        : {}),
      ...environmentCreateFields(user),
    };

    const firstResp = await this.supabaseService
      .getClient()
      .from('branches')
      .insert([payload])
      .select()
      .single();
    let { data, error } = BranchesService.unwrapSupabaseRow(firstResp);

    // If client-side generated code is stale, retry once using the next free code.
    if (error?.code === '23505' || /branch_code/i.test(error?.message ?? '')) {
      payload = {
        ...payload,
        branch_code: await this.getNextAvailableBranchCode(),
      };

      const retryResp = await this.supabaseService
        .getClient()
        .from('branches')
        .insert([payload])
        .select()
        .single();

      ({ data, error } = BranchesService.unwrapSupabaseRow(retryResp));
    }

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new InternalServerErrorException('Branch insert returned no row');
    }

    await this.notificationsService.createForSuperadmins({
      title: `New branch added - ${String(data.name)}`,
      subtitle: `System Alert: branch ${String(data.branch_code)} is now available.`,
      category: 'Alerts',
      event_key: `branch-created:${String(data.id)}`,
      entity_type: 'branch',
      entity_id: String(data.branch_code),
      ...environmentCreateFields(user),
    });

    return this.mapBranchFromDb(data);
  }

  async findAll(user: UserWithBranch) {
    try {
      const rows = await this.prisma.branches.findMany({
        where: applyEnvironmentFilter(user),
        select: this.branchCardSelect,
        orderBy: { created_at: 'desc' },
      });

      return rows.map((row) =>
        this.mapBranchFromDb(row as unknown as Record<string, unknown>),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not load branches';
      this.logger.error(
        `findAll branches failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        process.env.NODE_ENV !== 'production'
          ? message
          : 'Could not load branches',
      );
    }
  }

  /** Active branches available as transfer destinations in the item transfer modal. */
  async findTransferDestinations(user: UserWithBranch) {
    try {
      const rows = await this.prisma.branches.findMany({
        where: applyEnvironmentFilter(user, { status: 'Active' }),
        select: this.branchCardSelect,
        orderBy: { name: 'asc' },
      });

      return rows.map((row) =>
        this.mapBranchFromDb(row as unknown as Record<string, unknown>),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Could not load transfer destinations';
      this.logger.error(
        `findTransferDestinations failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        process.env.NODE_ENV !== 'production'
          ? message
          : 'Could not load transfer destinations',
      );
    }
  }

  /** Admin / employee: only their assigned branch. Super admin: all. */
  async findAllForActor(user: UserWithBranch) {
    try {
      if (user.role === Role.SUPER_ADMIN) {
        return await this.findAll(user);
      }

      const branchId = requireUserBranchId(user);
      const rows = await this.prisma.branches.findMany({
        where: applyEnvironmentFilter(user, { id: branchId }),
        select: this.branchCardSelect,
        orderBy: { created_at: 'desc' },
      });

      return rows.map((row) =>
        this.mapBranchFromDb(row as unknown as Record<string, unknown>),
      );
    } catch (error) {
      if (
        error instanceof InternalServerErrorException ||
        error instanceof HttpException
      ) {
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Could not load branches for user';
      this.logger.error(
        `findAllForActor branches failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        process.env.NODE_ENV !== 'production'
          ? message
          : 'Could not load branches',
      );
    }
  }

  /** Public signup/site listing: active branches only. */
  async findActiveSummaries() {
    try {
      const rows = await this.prisma.branches.findMany({
        where: { status: 'Active', environment: 'production' },
        select: { id: true, branch_code: true, name: true, location: true },
        orderBy: { name: 'asc' },
      });

      return rows;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(message);
    }
  }

  async findOne(id: string, user: UserWithBranch) {
    const data = await this.prisma.branches.findFirst({
      where: applyEnvironmentFilter(user, { id }),
    });

    if (!data) {
      throw new NotFoundException('Branch not found');
    }

    return this.mapBranchFromDb(data);
  }

  async update(
    id: string,
    updateBranchDto: UpdateBranchDto,
    user: UserWithBranch,
  ) {
    const existing = await this.prisma.branches.findFirst({
      where: applyEnvironmentFilter(user, { id }),
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Branch not found');
    }

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
      ...(user.role === Role.SUPER_ADMIN &&
      updateBranchDto.maintaining_balance !== undefined
        ? { maintaining_balance: updateBranchDto.maintaining_balance }
        : {}),
    };

    const patchResp = await this.supabaseService
      .getClient()
      .from('branches')
      .update(payload)
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .select()
      .single();

    const { data, error } = BranchesService.unwrapSupabaseRow(patchResp);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new InternalServerErrorException('Branch update returned no row');
    }

    return this.mapBranchFromDb(data);
  }

  async remove(id: string, user: UserWithBranch) {
    const rmResp = await this.supabaseService
      .getClient()
      .from('branches')
      .delete()
      .eq('id', id)
      .eq('environment', getEnvironment(user));

    const { error } = BranchesService.unwrapSupabaseRow(rmResp);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { deleted: true };
  }

  async getOverviewStats(user: UserWithBranch) {
    const [branchesMeta, pawnedResult, saleResult] = await Promise.all([
      this.prisma.branches.findMany({
        where: applyEnvironmentFilter(user),
        select: { id: true, inventory_valuation_mode: true },
      }),
      this.prisma.pawned_items.findMany({
        where: applyEnvironmentFilter(user),
        select: {
          branch_id: true,
          amount: true,
          status: true,
          appraised_value: true,
          estimated_resale_value: true,
        },
      }),
      this.prisma.sale_items.findMany({
        where: applyEnvironmentFilter(user),
        select: { branch_id: true, price: true, status: true },
      }),
    ]);

    const modeByBranch = new Map<string, InventoryValuationMode>();
    for (const b of branchesMeta) {
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
    for (const item of pawnedResult) {
      if (!item.branch_id) continue;
      if (!isStatusIncludedInInventoryValuation(item.status)) continue;
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

    for (const item of saleResult) {
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
