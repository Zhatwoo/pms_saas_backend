import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Role } from '../../common/enums';

interface UserRecord {
  id: string;
  auth_id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  branch_id: string | null;
  avatar_url: string | null;
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

  private async findUser(
    column: 'id' | 'auth_id',
    value: string,
  ): Promise<AuthenticatedUserProfile | null> {
    const { data, error } = await this.client
      .from('users')
      .select('id, auth_id, email, full_name, role, branch_id, avatar_url')
      .eq(column, value)
      .maybeSingle<UserRecord>();

    if (error || !data) {
      return null;
    }

    return this.mapUserRecord(data);
  }

  async getUserById(userId: string) {
    return this.findUser('id', userId);
  }

  async getUserByAuthId(authUserId: string) {
    return this.findUser('auth_id', authUserId);
  }
}
