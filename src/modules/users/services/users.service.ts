import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../../infrastructure/prisma';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

type UserRow = Prisma.usersGetPayload<{
  select: typeof UsersService.userSelect;
}>;

const UUID_PARAM_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class UsersService {
  static readonly userSelect = {
    id: true,
    auth_id: true,
    email: true,
    full_name: true,
    role: true,
    branch_id: true,
    avatar_url: true,
    account_status: true,
    created_at: true,
    branches: { select: { name: true } },
  } satisfies Prisma.usersSelect;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private isUuidParam(value: string): boolean {
    return UUID_PARAM_RE.test(value.trim());
  }

  private isActiveBranchStatus(status: string | null | undefined): boolean {
    return status?.trim().toLowerCase() === 'active';
  }

  private normalizeStoredRole(role: string): string {
    if (role === 'superadmin') return 'super_admin';
    if (role === 'branch') return 'employee';
    return role;
  }

  private async verifyActorPassword(
    actor: AuthenticatedUserProfile,
    password: string,
  ): Promise<void> {
    const authClient = this.supabaseService.getAuthClient();
    const { error } = await authClient.auth.signInWithPassword({
      email: actor.email,
      password,
    });

    if (error) {
      throw new UnauthorizedException('Invalid password');
    }
  }

  private async fetchUserRowByIdOrAuthId(idParam: string) {
    const trimmed = idParam.trim();
    if (!this.isUuidParam(trimmed)) return null;

    return this.prisma.users.findFirst({
      where: { OR: [{ id: trimmed }, { auth_id: trimmed }] },
      select: UsersService.userSelect,
    });
  }

  private mapToResponse(row: UserRow) {
    return {
      id: row.id,
      authId: row.auth_id,
      email: row.email,
      fullName: this.encryption.decryptUserFullName(row.full_name),
      role: this.normalizeStoredRole(row.role ?? ''),
      branchId: row.branch_id,
      branchName: row.branches?.name ?? null,
      accountStatus: row.account_status ?? 'active',
      createdAt: row.created_at,
    };
  }

  async findAll(scope?: { branchId: string; forBranchAdmin: true }) {
    const where: Prisma.usersWhereInput = {};

    if (scope?.forBranchAdmin && scope.branchId) {
      Object.assign(where, {
        branch_id: scope.branchId,
        role: { in: ['admin', 'employee', 'branch'] },
      });
    }

    const rows = await this.prisma.users.findMany({
      where,
      select: UsersService.userSelect,
      orderBy: { created_at: 'desc' },
      take: 500,
    });

    return rows.map((row) => this.mapToResponse(row));
  }

  async findOne(id: string, viewer?: AuthenticatedUserProfile) {
    const row = await this.fetchUserRowByIdOrAuthId(id);
    if (!row) throw new NotFoundException('User not found');

    if (viewer && viewer.role === Role.ADMIN) {
      const targetRole = this.normalizeStoredRole(row.role ?? '');
      if (targetRole === 'super_admin') {
        throw new ForbiddenException('You cannot access Super Admin accounts');
      }
      if (String(row.branch_id) !== String(viewer.branchId)) {
        throw new ForbiddenException(
          'You cannot access users outside your branch',
        );
      }
    }

    return this.mapToResponse(row);
  }

  async create(dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const normalizedRole = this.normalizeStoredRole(dto.role);
    const isTargetSuperAdmin = normalizedRole === 'super_admin';
    const effectiveBranchId = isTargetSuperAdmin
      ? null
      : (dto.branchId ?? null);

    let branch: { id: string; status: string; name: string } | null = null;
    if (!isTargetSuperAdmin) {
      if (!effectiveBranchId) {
        throw new BadRequestException('Branch is required for this role');
      }

      branch = await this.prisma.branches.findUnique({
        where: { id: effectiveBranchId },
        select: { id: true, status: true, name: true },
      });

      if (!branch || !this.isActiveBranchStatus(branch.status)) {
        throw new BadRequestException('Invalid or inactive branch');
      }
    }

    const client = this.supabaseService.getClient();
    const { data: authData, error: authError } =
      await client.auth.admin.createUser({
        email,
        password: dto.password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
        app_metadata: {
          role: normalizedRole,
          branch_id: effectiveBranchId,
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
    try {
      const row = await this.prisma.users.upsert({
        where: { auth_id: authId },
        create: {
          auth_id: authId,
          email,
          full_name: this.encryption.encryptUserFullName(fullName),
          role: normalizedRole,
          branch_id: effectiveBranchId,
          account_status: 'active',
        },
        update: {
          email,
          full_name: this.encryption.encryptUserFullName(fullName),
          role: normalizedRole,
          branch_id: effectiveBranchId,
          account_status: 'active',
          updated_at: new Date(),
        },
        select: UsersService.userSelect,
      });

      return this.mapToResponse({
        ...row,
        branches: branch ? { name: branch.name } : row.branches,
      });
    } catch (err) {
      await client.auth.admin.deleteUser(authId);
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor?: AuthenticatedUserProfile,
  ) {
    if (
      dto.fullName === undefined &&
      dto.avatarUrl === undefined &&
      dto.accountStatus === undefined &&
      dto.role === undefined &&
      dto.branchId === undefined
    ) {
      throw new BadRequestException('No updates provided');
    }

    const existing = await this.fetchUserRowByIdOrAuthId(id);
    if (!existing) throw new NotFoundException('User not found');

    const roleNorm = this.normalizeStoredRole(existing.role ?? '');

    if (actor?.role === Role.ADMIN) {
      const isSelf =
        actor.id === existing.id ||
        actor.authId === existing.auth_id ||
        actor.email?.toLowerCase() === existing.email.toLowerCase();

      if (roleNorm === 'super_admin') {
        throw new ForbiddenException('Admin cannot edit Super Admin accounts');
      }
      if (!isSelf && roleNorm !== 'employee') {
        throw new ForbiddenException(
          'Admin can only edit employee accounts or their own profile',
        );
      }
      if (
        dto.role !== undefined ||
        dto.accountStatus !== undefined ||
        dto.branchId !== undefined ||
        dto.avatarUrl !== undefined ||
        dto.currentPassword !== undefined
      ) {
        throw new ForbiddenException(
          'Admin updates are limited to full name only',
        );
      }
    }

    if (roleNorm === 'super_admin' && dto.accountStatus === 'rejected') {
      throw new ForbiddenException('Cannot reject a Super Admin account');
    }

    const nextRole =
      dto.role !== undefined ? this.normalizeStoredRole(dto.role) : undefined;
    const crossesSuperAdminBoundary =
      nextRole !== undefined &&
      ((nextRole === 'super_admin' && roleNorm !== 'super_admin') ||
        (roleNorm === 'super_admin' && nextRole !== 'super_admin'));

    if (crossesSuperAdminBoundary) {
      if (!actor || !dto.currentPassword?.trim()) {
        throw new UnauthorizedException(
          'Password confirmation is required to change Super Admin access.',
        );
      }
      await this.verifyActorPassword(actor, dto.currentPassword.trim());
    }

    const payload: Prisma.usersUncheckedUpdateInput = {
      updated_at: new Date(),
    };

    if (dto.fullName !== undefined) {
      const trimmed = dto.fullName.trim();
      if (trimmed) {
        payload.full_name = this.encryption.encryptUserFullName(trimmed);
        await this.supabaseService
          .getClient()
          .auth.admin.updateUserById(existing.auth_id, {
            user_metadata: { full_name: trimmed },
          });
      }
    }

    if (dto.accountStatus !== undefined)
      payload.account_status = dto.accountStatus;
    if (nextRole !== undefined) {
      payload.role = nextRole;
      if (nextRole === 'super_admin') payload.branch_id = null;
    }

    if (dto.branchId !== undefined) {
      const effectiveRole = nextRole ?? roleNorm;
      if (effectiveRole === 'super_admin' || dto.branchId === null) {
        payload.branch_id = null;
      } else {
        const branch = await this.prisma.branches.findUnique({
          where: { id: dto.branchId },
          select: { id: true, status: true },
        });
        if (!branch || !this.isActiveBranchStatus(branch.status)) {
          throw new BadRequestException('Invalid or inactive branch');
        }
        payload.branch_id = dto.branchId;
      }
    }

    if (dto.avatarUrl !== undefined) payload.avatar_url = dto.avatarUrl;

    const updated = await this.prisma.users.update({
      where: { auth_id: existing.auth_id },
      data: payload,
      select: UsersService.userSelect,
    });

    if (dto.role !== undefined || dto.branchId !== undefined) {
      const { error } = await this.supabaseService
        .getClient()
        .auth.admin.updateUserById(existing.auth_id, {
          app_metadata: {
            role: updated.role,
            branch_id:
              this.normalizeStoredRole(updated.role ?? '') === 'super_admin'
                ? null
                : updated.branch_id,
          },
        });
      if (error) throw new InternalServerErrorException(error.message);
    }

    return this.mapToResponse(updated);
  }

  async transferBranch(id: string, targetBranchId: string) {
    const existing = await this.fetchUserRowByIdOrAuthId(id);
    if (!existing) throw new NotFoundException('User not found');

    const roleNorm = this.normalizeStoredRole(existing.role ?? '');
    if (roleNorm === 'super_admin') {
      throw new ForbiddenException(
        'Super Admin accounts cannot be transferred',
      );
    }
    if (String(existing.branch_id) === String(targetBranchId)) {
      throw new BadRequestException('User is already assigned to this branch');
    }

    const targetBranch = await this.prisma.branches.findUnique({
      where: { id: targetBranchId },
      select: { id: true, status: true, name: true },
    });
    if (!targetBranch || !this.isActiveBranchStatus(targetBranch.status)) {
      throw new BadRequestException('Invalid or inactive target branch');
    }

    const updated = await this.prisma.users.update({
      where: { auth_id: existing.auth_id },
      data: { branch_id: targetBranchId, updated_at: new Date() },
      select: UsersService.userSelect,
    });

    const { error } = await this.supabaseService
      .getClient()
      .auth.admin.updateUserById(existing.auth_id, {
        app_metadata: { role: updated.role, branch_id: targetBranchId },
      });
    if (error) throw new InternalServerErrorException(error.message);

    return this.mapToResponse({
      ...updated,
      branches: { name: targetBranch.name },
    });
  }

  async remove(id: string) {
    const existing = await this.fetchUserRowByIdOrAuthId(id);
    if (!existing) throw new NotFoundException('User not found');

    const roleNorm = this.normalizeStoredRole(existing.role ?? '');
    if (roleNorm === 'super_admin') {
      throw new ForbiddenException('Cannot delete a Super Admin account');
    }

    // Users table has no deleted_at column, so account_status is the soft-delete
    // marker. Auth deletion prevents future JWT issuance without removing audit
    // history that points to public.users.id.
    await this.prisma.users.update({
      where: { auth_id: existing.auth_id },
      data: { account_status: 'rejected', updated_at: new Date() },
    });

    const { error } = await this.supabaseService
      .getClient()
      .auth.admin.deleteUser(existing.auth_id);
    if (error) throw new InternalServerErrorException(error.message);

    return {
      deleted: true,
      targetUserId: existing.id,
      targetUserName:
        this.encryption.decryptUserFullName(existing.full_name)?.trim() ||
        existing.email,
    };
  }
}
