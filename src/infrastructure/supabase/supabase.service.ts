import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Role } from '../../common/enums';

export type AccountStatus = 'pending' | 'active' | 'rejected';

interface UserRecord {
  id: string;
  auth_id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  branch_id: string | null;
  avatar_url: string | null;
  account_status: AccountStatus | null;
}

export interface AuthenticatedUserProfile {
  id: string;
  authId: string;
  fullName: string | null;
  email: string;
  role: Role;
  branchId: string | null;
  avatarUrl: string | null;
}

const USER_SELECT_COLUMNS =
  'id, auth_id, email, full_name, role, branch_id, avatar_url, account_status';

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;

  constructor(private configService: ConfigService) {
    const url = this.configService.get<string>('supabase.url');
    const serviceRoleKey = this.configService.get<string>(
      'supabase.serviceRoleKey',
    );

    if (!url || !serviceRoleKey) {
      throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment',
      );
    }

    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  private normalizeRole(role: string | null): Role | null {
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
        return null;
    }
  }

  private mapUserRecord(user: UserRecord): AuthenticatedUserProfile | null {
    const role = this.normalizeRole(user.role);

    if (!role) {
      return null;
    }

    return {
      id: user.id,
      authId: user.auth_id,
      fullName: user.full_name,
      email: user.email,
      role,
      branchId: user.branch_id,
      avatarUrl: user.avatar_url,
    };
  }

  private normalizeAccountStatus(
    value: string | null | undefined,
  ): AccountStatus {
    if (value === 'pending' || value === 'rejected') {
      return value;
    }
    return 'active';
  }

  private async fetchUserRow(
    column: 'id' | 'auth_id',
    value: string,
  ): Promise<UserRecord | null> {
    const { data, error } = await this.client
      .from('users')
      .select(USER_SELECT_COLUMNS)
      .eq(column, value)
      .maybeSingle<UserRecord>();

    if (error || !data) {
      return null;
    }

    return data;
  }

  /**
   * Only for active accounts (login + JWT). Pending/rejected are blocked.
   */
  async assertSessionUserByAuthId(
    authUserId: string,
  ): Promise<AuthenticatedUserProfile> {
    const row = await this.fetchUserRow('auth_id', authUserId);

    if (!row) {
      throw new UnauthorizedException('User account not found');
    }

    const status = this.normalizeAccountStatus(row.account_status);

    if (status === 'pending') {
      throw new UnauthorizedException('Account pending approval');
    }

    if (status === 'rejected') {
      throw new UnauthorizedException('Account rejected');
    }

    const profile = this.mapUserRecord(row);

    if (!profile) {
      throw new UnauthorizedException('User account not found');
    }

    return profile;
  }

  /**
   * Only for active accounts (/auth/me and similar).
   */
  async assertSessionUserById(
    userId: string,
  ): Promise<AuthenticatedUserProfile> {
    const row = await this.fetchUserRow('id', userId);

    if (!row) {
      throw new UnauthorizedException('User account not found');
    }

    const status = this.normalizeAccountStatus(row.account_status);

    if (status === 'pending') {
      throw new UnauthorizedException('Account pending approval');
    }

    if (status === 'rejected') {
      throw new UnauthorizedException('Account rejected');
    }

    const profile = this.mapUserRecord(row);

    if (!profile) {
      throw new UnauthorizedException('User account not found');
    }

    return profile;
  }
}
