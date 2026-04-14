import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

interface UserRow {
  id: string;
  auth_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  branch_id: string | null;
  avatar_url: string | null;
  account_status: string | null;
  created_at: string;
}

const UUID_PARAM_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class UsersService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private isUuidParam(value: string): boolean {
    return UUID_PARAM_RE.test(value.trim());
  }

  private isActiveBranchStatus(status: string | null | undefined): boolean {
    return status?.trim().toLowerCase() === 'active';
  }

  private formatSupabaseError(err: {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
  }): string {
    const parts = [err.message, err.code, err.details, err.hint].filter(
      (p): p is string => Boolean(p && String(p).trim()),
    );
    return parts.length > 0 ? parts.join(' | ') : 'Database request failed';
  }

  /** Match `public.users.id` or `auth.users` id stored in `auth_id`. */
  private async fetchUserRowByIdOrAuthId(
    client: ReturnType<SupabaseService['getClient']>,
    idParam: string,
  ): Promise<{ row: UserRow | null; error: { message?: string } | null }> {
    const trimmed = idParam.trim();
    if (!this.isUuidParam(trimmed)) {
      return { row: null, error: null };
    }

    const { data, error } = await client
      .from('users')
      .select(
        'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status, created_at',
      )
      .or(`id.eq.${trimmed},auth_id.eq.${trimmed}`)
      .maybeSingle<UserRow>();

    return { row: data ?? null, error };
  }

  private normalizeStoredRole(role: string): string {
    if (role === 'superadmin') {
      return 'super_admin';
    }
    if (role === 'branch') {
      return 'employee';
    }
    return role;
  }

  private mapToResponse(row: UserRow, branchName: string | null) {
    return {
      id: row.id,
      authId: row.auth_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      branchId: row.branch_id,
      branchName,
      accountStatus: row.account_status ?? 'active',
      createdAt: row.created_at,
    };
  }

  /**
   * Super admin: all users, all branches.
   * Branch admin: only `admin`, `employee`, `branch` roles in that branch (no super admins).
   */
  async findAll(scope?: { branchId: string; forBranchAdmin: true } | undefined) {
    const client = this.supabaseService.getClient();

    let q = client
      .from('users')
      .select(
        'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status, created_at',
      )
      .order('created_at', { ascending: false });

    if (scope?.forBranchAdmin && scope.branchId) {
      q = q
        .eq('branch_id', scope.branchId)
        .in('role', ['admin', 'employee', 'branch']);
    }

    const { data: users, error } = await q;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const rows = (users ?? []) as UserRow[];
    const branchIds = [
      ...new Set(
        rows
          .map((u) => u.branch_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const branchMap = new Map<string, string>();
    if (branchIds.length > 0) {
      const { data: branches, error: branchError } = await client
        .from('branches')
        .select('id, name')
        .in('id', branchIds);

      if (branchError) {
        throw new InternalServerErrorException(branchError.message);
      }

      (branches ?? []).forEach((b: { id: string; name: string }) => {
        branchMap.set(b.id, b.name);
      });
    }

    return rows.map((row) =>
      this.mapToResponse(
        row,
        row.branch_id ? branchMap.get(row.branch_id) ?? null : null,
      ),
    );
  }

  async findOne(id: string, viewer?: AuthenticatedUserProfile) {
    const client = this.supabaseService.getClient();

    const { row, error } = await this.fetchUserRowByIdOrAuthId(client, id);

    if (error?.message) {
      throw new InternalServerErrorException(this.formatSupabaseError(error));
    }

    if (!row) {
      throw new NotFoundException('User not found');
    }

    if (viewer && viewer.role === Role.ADMIN) {
      const targetRole = (row.role ?? '').toLowerCase();
      if (targetRole === 'super_admin' || targetRole === 'superadmin') {
        throw new ForbiddenException('You cannot access Super Admin accounts');
      }
      if (String(row.branch_id) !== String(viewer.branchId)) {
        throw new ForbiddenException('You cannot access users outside your branch');
      }
    }

    let branchName: string | null = null;
    if (row.branch_id) {
      const { data: branch } = await client
        .from('branches')
        .select('name')
        .eq('id', row.branch_id)
        .maybeSingle<{ name: string }>();
      branchName = branch?.name ?? null;
    }

    return this.mapToResponse(row, branchName);
  }

  async create(dto: CreateUserDto) {
    const client = this.supabaseService.getClient();
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const normalizedRole = this.normalizeStoredRole(dto.role);

    const { data: branch, error: branchError } = await client
      .from('branches')
      .select('id, status, name')
      .eq('id', dto.branchId)
      .maybeSingle<{ id: string; status: string; name: string }>();

    if (
      branchError ||
      !branch ||
      !this.isActiveBranchStatus(branch.status)
    ) {
      throw new BadRequestException('Invalid or inactive branch');
    }

    const { data: authData, error: authError } =
      await client.auth.admin.createUser({
        email,
        password: dto.password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
        app_metadata: {
          role: normalizedRole,
          branch_id: dto.branchId,
        },
      });

    if (authError || !authData.user) {
      const msg = authError?.message ?? 'Failed to create user';
      if (/already|registered|exists/i.test(msg)) {
        throw new BadRequestException('Email already in use');
      }
      throw new InternalServerErrorException(msg);
    }

    const authId = authData.user.id;

    const { error: syncAuthError } = await client.auth.admin.updateUserById(
      authId,
      {
        email,
        user_metadata: { full_name: fullName },
        app_metadata: {
          role: normalizedRole,
          branch_id: dto.branchId,
        },
      },
    );

    if (syncAuthError) {
      await client.auth.admin.deleteUser(authId);
      throw new InternalServerErrorException(syncAuthError.message);
    }

    const { data: updatedRows, error: updateError } = await client
      .from('users')
      .update({
        email,
        full_name: fullName,
        role: normalizedRole,
        branch_id: dto.branchId,
        account_status: 'active',
      })
      .eq('auth_id', authId)
      .select(
        'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status, created_at',
      );

    if (updateError) {
      await client.auth.admin.deleteUser(authId);
      throw new InternalServerErrorException(
        this.formatSupabaseError(updateError),
      );
    }

    let inserted = (updatedRows ?? [])[0] as UserRow | undefined;
    if (!inserted) {
      const { data: fetchedRow, error: fetchError } = await client
        .from('users')
        .select(
          'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status, created_at',
        )
        .eq('auth_id', authId)
        .maybeSingle<UserRow>();

      if (fetchError || !fetchedRow) {
        await client.auth.admin.deleteUser(authId);
        throw new InternalServerErrorException(
          fetchError
            ? this.formatSupabaseError(fetchError)
            : 'Failed to load created user profile',
        );
      }

      inserted = fetchedRow;
    }

    return this.mapToResponse(inserted, branch.name);
  }

  async update(id: string, dto: UpdateUserDto) {
    if (
      dto.accountStatus === undefined &&
      dto.role === undefined &&
      dto.branchId === undefined
    ) {
      throw new BadRequestException('No updates provided');
    }

    const client = this.supabaseService.getClient();

    const { row: existing, error: findError } =
      await this.fetchUserRowByIdOrAuthId(client, id);

    if (findError?.message) {
      throw new InternalServerErrorException(
        this.formatSupabaseError(findError),
      );
    }

    if (!existing) {
      throw new NotFoundException('User not found');
    }

    const authId = String(existing.auth_id ?? '').trim();
    const publicId = String(existing.id ?? '').trim();
    if (!authId) {
      throw new InternalServerErrorException(
        'User row is missing auth_id; cannot update profile.',
      );
    }

    const roleNorm = (existing.role ?? '').toLowerCase();
    if (
      roleNorm === 'super_admin' ||
      roleNorm === 'superadmin'
    ) {
      if (dto.accountStatus === 'rejected') {
        throw new ForbiddenException('Cannot reject a Super Admin account');
      }
    }

    const payload: Record<string, unknown> = {};

    if (dto.fullName !== undefined) {
      const trimmed = dto.fullName.trim();
      if (trimmed) {
        payload.full_name = trimmed;
        // Keep Auth metadata in sync
        await client.auth.admin.updateUserById(authId, {
          user_metadata: { full_name: trimmed },
        });
      }
    }

    if (dto.accountStatus !== undefined) {
      payload.account_status = dto.accountStatus;
    }

    if (dto.role !== undefined) {
      const next = this.normalizeStoredRole(dto.role);
      if (next === 'super_admin' && roleNorm !== 'super_admin' && roleNorm !== 'superadmin') {
        throw new ForbiddenException('Cannot assign Super Admin via this endpoint');
      }
      payload.role = next;
    }

    if (dto.branchId !== undefined) {
      if (dto.branchId === null) {
        payload.branch_id = null;
      } else {
        const { data: branch, error: branchError } = await client
          .from('branches')
          .select('id, status')
          .eq('id', dto.branchId)
          .maybeSingle<{ id: string; status: string }>();

        if (
          branchError ||
          !branch ||
          !this.isActiveBranchStatus(branch.status)
        ) {
          throw new BadRequestException('Invalid or inactive branch');
        }
        payload.branch_id = dto.branchId;
      }
    }

    const selectColumns =
      'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status, created_at';

    // Prefer auth_id: unique, stable, and matches the auth user even if public `id` drifts in clients.
    let { data: updatedRows, error: updateError } = await client
      .from('users')
      .update(payload)
      .eq('auth_id', authId)
      .select(selectColumns);

    if (updateError) {
      throw new InternalServerErrorException(
        this.formatSupabaseError(updateError),
      );
    }

    let updated = (updatedRows ?? [])[0] as UserRow | undefined;

    if (!updated && publicId) {
      const second = await client
        .from('users')
        .update(payload)
        .eq('id', publicId)
        .select(selectColumns);
      if (second.error) {
        throw new InternalServerErrorException(
          this.formatSupabaseError(second.error),
        );
      }
      updated = (second.data ?? [])[0] as UserRow | undefined;
    }

    if (!updated) {
      throw new InternalServerErrorException(
        'User update returned no row (check database policies and users table).',
      );
    }

    let branchName: string | null = null;
    if (updated.branch_id) {
      const { data: branch } = await client
        .from('branches')
        .select('name')
        .eq('id', updated.branch_id)
        .maybeSingle<{ name: string }>();
      branchName = branch?.name ?? null;
    }

    return this.mapToResponse(updated, branchName);
  }

  async transferBranch(id: string, targetBranchId: string) {
    const client = this.supabaseService.getClient();

    const { row: existing, error: findError } =
      await this.fetchUserRowByIdOrAuthId(client, id);

    if (findError?.message) {
      throw new InternalServerErrorException(
        this.formatSupabaseError(findError),
      );
    }

    if (!existing) {
      throw new NotFoundException('User not found');
    }

    const roleNorm = (existing.role ?? '').toLowerCase();
    if (roleNorm === 'super_admin' || roleNorm === 'superadmin') {
      throw new ForbiddenException('Super Admin accounts cannot be transferred');
    }

    if (String(existing.branch_id) === String(targetBranchId)) {
      throw new BadRequestException('User is already assigned to this branch');
    }

    const { data: targetBranch, error: targetBranchError } = await client
      .from('branches')
      .select('id, status, name')
      .eq('id', targetBranchId)
      .maybeSingle<{ id: string; status: string; name: string }>();

    if (
      targetBranchError ||
      !targetBranch ||
      !this.isActiveBranchStatus(targetBranch.status)
    ) {
      throw new BadRequestException('Invalid or inactive target branch');
    }

    const { data: updatedRows, error: updateError } = await client
      .from('users')
      .update({ branch_id: targetBranchId })
      .eq('auth_id', existing.auth_id)
      .select(
        'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status, created_at',
      );

    if (updateError) {
      throw new InternalServerErrorException(
        this.formatSupabaseError(updateError),
      );
    }

    const updated = (updatedRows ?? [])[0] as UserRow | undefined;
    if (!updated) {
      throw new InternalServerErrorException('Failed to update user branch assignment');
    }

    const appMetaUpdate = await client.auth.admin.updateUserById(existing.auth_id, {
      app_metadata: {
        role: updated.role,
        branch_id: targetBranchId,
      },
    });

    if (appMetaUpdate.error) {
      throw new InternalServerErrorException(appMetaUpdate.error.message);
    }

    return this.mapToResponse(updated, targetBranch.name);
  }

  async remove(id: string) {
    const client = this.supabaseService.getClient();

    const { row: existingRow, error: findError } =
      await this.fetchUserRowByIdOrAuthId(client, id);

    if (findError?.message) {
      throw new InternalServerErrorException(
        this.formatSupabaseError(findError),
      );
    }

    if (!existingRow) {
      throw new NotFoundException('User not found');
    }

    const existing = {
      id: existingRow.id,
      auth_id: existingRow.auth_id,
      role: existingRow.role,
    };

    const roleNorm = (existing.role ?? '').toLowerCase();
    if (roleNorm === 'super_admin' || roleNorm === 'superadmin') {
      throw new ForbiddenException('Cannot delete a Super Admin account');
    }

    const { error: authDeleteError } = await client.auth.admin.deleteUser(
      existing.auth_id,
    );

    if (authDeleteError) {
      throw new InternalServerErrorException(authDeleteError.message);
    }

    return { deleted: true };
  }
}
