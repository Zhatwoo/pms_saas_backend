import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Role } from '../enums';
import { PrismaService } from '../../infrastructure/prisma';
import { EncryptionService } from '../encryption/encryption.service';

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
  branches?: { name: string } | null;
}

export interface AuthenticatedUserProfile {
  id: string;
  authId: string;
  fullName: string | null;
  email: string;
  role: Role;
  branchId: string | null;
  branchName: string | null;
  avatarUrl: string | null;
}

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;
  private readonly url: string;
  private readonly anonKey: string;

  constructor(
    private configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');
    const serviceRoleKey = this.configService.get<string>(
      'supabase.serviceRoleKey',
    );

    if (!url || !serviceRoleKey) {
      throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment',
      );
    }

    this.url = url;
    this.anonKey = anonKey || '';
    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  getAuthClient(): SupabaseClient {
    if (!this.url || !this.anonKey) {
      throw new Error(
        'Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment',
      );
    }

    return createClient(this.url, this.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
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
      fullName: this.encryption.decryptUserFullName(user.full_name),
      email: user.email,
      role,
      branchId: user.branch_id,
      branchName: user.branches?.name ?? null,
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
    try {
      if (!value) {
        console.warn(
          `[SupabaseService] fetchUserRow: missing value for column ${column}`,
        );
        return null;
      }

      const data = await this.prisma.users.findFirst({
        where: { [column]: value },
        select: {
          id: true,
          auth_id: true,
          email: true,
          full_name: true,
          role: true,
          branch_id: true,
          avatar_url: true,
          account_status: true,
          branches: { select: { name: true } },
        },
      });

      if (!data) {
        console.warn(
          `[SupabaseService] fetchUserRow: No user found for ${column}=${value}`,
        );
      }

      return data as UserRecord | null;
    } catch (err) {
      console.error(
        `[SupabaseService] fetchUserRow critical crash (${column}=${value}):`,
        err,
      );
      throw new InternalServerErrorException(
        'Database connection failed while loading user account',
      );
    }
  }

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
