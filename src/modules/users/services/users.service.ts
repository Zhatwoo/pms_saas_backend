import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../common/enums';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { CreateUserDto } from '../dto/create-user.dto';

interface BranchRow {
  id: string;
  name: string;
  branch_code: string;
}

interface UserRow {
  id: string;
  auth_id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  branch_id: string | null;
  avatar_url: string | null;
  created_at: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private normalizeRole(role: string | null): Role {
    switch (role) {
      case 'super_admin':
      case 'superadmin':
        return Role.SUPER_ADMIN;
      case 'admin':
        return Role.ADMIN;
      case 'employee':
      case 'branch':
        return Role.EMPLOYEE;
      default:
        return Role.EMPLOYEE;
    }
  }

  private formatUser(user: UserRow, branches: Map<string, BranchRow>) {
    const branch = user.branch_id ? branches.get(user.branch_id) : null;

    if (!branch && user.branch_id) {
      console.warn('[formatUser] Branch not found in map:', {
        email: user.email,
        branchId: user.branch_id,
        availableBranchIds: Array.from(branches.keys()),
      });
    }

    return {
      id: user.id,
      authId: user.auth_id,
      fullName: user.full_name,
      email: user.email,
      role: this.normalizeRole(user.role),
      branchId: user.branch_id,
      branchName: branch?.name ?? null,
      branchCode: branch?.branch_code ?? null,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      status: 'active' as const,
    };
  }

  private async getBranchMap() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('id, name, branch_code');

    if (error) {
      console.error('[getBranchMap] Error:', error);
      throw new InternalServerErrorException(error.message);
    }

    console.log('[getBranchMap] Branches loaded:', data?.length ?? 0, {
      branches: data?.map((b) => ({ id: b.id, name: b.name })),
    });

    return new Map(
      (data ?? []).map((branch) => [branch.id, branch as BranchRow]),
    );
  }

  private async getBranchOrThrow(branchId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('id, name, branch_code')
      .eq('id', branchId)
      .maybeSingle<BranchRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new BadRequestException('Selected branch was not found');
    }

    return data;
  }

  private async getUserRowByAuthId(authId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('users')
      .select(
        'id, auth_id, full_name, email, role, branch_id, avatar_url, created_at',
      )
      .eq('auth_id', authId)
      .maybeSingle<UserRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  private async syncUserRowFromAuth(params: {
    authId: string;
    email: string;
    fullName: string;
    role: CreateUserDto['role'];
    branchId: string;
  }) {
    console.log('[syncUserRowFromAuth] Waiting for trigger to sync user:', params.authId);

    // The trigger automatically creates the user when auth user is created
    // We just need to wait a moment and fetch it
    // Retry a few times in case there's a slight delay
    let user: UserRow | null = null;
    let attempts = 0;
    const maxAttempts = 5;

    while (!user && attempts < maxAttempts) {
      attempts++;
      console.log(`[syncUserRowFromAuth] Fetch attempt ${attempts}/${maxAttempts}`);

      const { data, error } = await this.supabaseService
        .getClient()
        .from('users')
        .select(
          'id, auth_id, full_name, email, role, branch_id, avatar_url, created_at',
        )
        .eq('auth_id', params.authId)
        .maybeSingle<UserRow>();

      if (error) {
        console.error('[syncUserRowFromAuth] Fetch error:', error);
        throw new InternalServerErrorException(error.message);
      }

      if (data) {
        console.log('[syncUserRowFromAuth] User found:', data.id);
        user = data;
        break;
      }

      // Wait 100ms before retry
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (!user) {
      throw new InternalServerErrorException(
        'User was created in authentication but not synced to database. The trigger may not have executed.',
      );
    }

    return user;
  }

  async create(createUserDto: CreateUserDto) {
    const branch = await this.getBranchOrThrow(createUserDto.branchId);
    const email = createUserDto.email.trim().toLowerCase();
    const fullName = createUserDto.fullName.trim();

    console.log('[UsersService.create] Creating auth user:', { email, fullName, branchId: createUserDto.branchId });

    const authPayload = {
      email,
      password: createUserDto.password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
      },
      app_metadata: {
        role: createUserDto.role,
        branch_id: createUserDto.branchId,
      },
    };

    console.log('[UsersService.create] Auth payload:', authPayload);

    const { data: authData, error: authError } =
      await this.supabaseService.getClient().auth.admin.createUser(authPayload as any);

    if (authError || !authData.user) {
      console.error('[UsersService.create] Auth error:', authError);
      throw new BadRequestException(
        authError?.message ?? 'Failed to create user in authentication',
      );
    }

    console.log('[UsersService.create] Auth user created:', {
      id: authData.user.id,
      email: authData.user.email,
      app_metadata: authData.user.app_metadata,
    });

    // The trigger will sync the user to public.users, just fetch it
    let data: UserRow;
    try {
      data = await this.syncUserRowFromAuth({
        authId: authData.user.id,
        email,
        fullName,
        role: createUserDto.role,
        branchId: createUserDto.branchId,
      });
    } catch (error) {
      // If sync fails, delete the auth user since the trigger didn't work
      console.error('[UsersService.create] Sync failed, rolling back auth user:', error);
      await this.supabaseService
        .getClient()
        .auth.admin.deleteUser(authData.user.id);
      throw error;
    }

    return this.formatUser(
      data,
      new Map([[branch.id, branch]]),
    );
  }

  async findAll() {
    const [branches, usersResult] = await Promise.all([
      this.getBranchMap(),
      this.supabaseService
        .getClient()
        .from('users')
        .select(
          'id, auth_id, full_name, email, role, branch_id, avatar_url, created_at',
        )
        .order('created_at', { ascending: false }),
    ]);

    if (usersResult.error) {
      throw new InternalServerErrorException(usersResult.error.message);
    }

    return (usersResult.data ?? []).map((user) =>
      this.formatUser(user as UserRow, branches),
    );
  }

  async findOne(id: string) {
    const [branches, userResult] = await Promise.all([
      this.getBranchMap(),
      this.supabaseService
        .getClient()
        .from('users')
        .select(
          'id, auth_id, full_name, email, role, branch_id, avatar_url, created_at',
        )
        .eq('id', id)
        .maybeSingle<UserRow>(),
    ]);

    if (userResult.error) {
      throw new InternalServerErrorException(userResult.error.message);
    }

    if (!userResult.data) {
      throw new NotFoundException('User not found');
    }

    return this.formatUser(userResult.data, branches);
  }

  async remove(id: string) {
    const { data: existingUser, error: existingUserError } =
      await this.supabaseService
        .getClient()
        .from('users')
        .select('id, auth_id, role')
        .eq('id', id)
        .maybeSingle<{ id: string; auth_id: string; role: string | null }>();

    if (existingUserError) {
      throw new InternalServerErrorException(existingUserError.message);
    }

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    if (this.normalizeRole(existingUser.role) === Role.SUPER_ADMIN) {
      throw new BadRequestException('Super admin accounts cannot be deleted here');
    }

    const { error: deleteProfileError } = await this.supabaseService
      .getClient()
      .from('users')
      .delete()
      .eq('id', id);

    if (deleteProfileError) {
      throw new InternalServerErrorException(deleteProfileError.message);
    }

    const { error: deleteAuthError } = await this.supabaseService
      .getClient()
      .auth.admin.deleteUser(existingUser.auth_id);

    return {
      deleted: true,
      authDeleted: !deleteAuthError,
      warning: deleteAuthError?.message ?? null,
    };
  }
}
