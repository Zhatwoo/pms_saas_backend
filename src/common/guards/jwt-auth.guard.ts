import {
  Injectable,
  ExecutionContext,
  CanActivate,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SupabaseService } from '../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../infrastructure/prisma';
import { Role } from '../enums';
import { parseCookieHeader } from '../utils/cookie.util';
import type { Request } from 'express';

type UserRow = {
  id: string;
  auth_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  branch_id: string | null;
  avatar_url: string | null;
  account_status: string | null;
  branches?: { name: string } | null;
};

type RequestUser = {
  id: string;
  authId: string;
  fullName: string | null;
  email: string;
  role: Role;
  branchId: string | null;
  branchName: string | null;
  avatarUrl: string | null;
};

type AuthenticatedRequest = Request & { user?: RequestUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const token = this.extractSessionToken(request);
    if (!token) {
      this.logger.warn(
        `Missing session cookie for ${request.method} ${request.path}`,
      );
      throw new UnauthorizedException('Missing session');
    }

    const authClient = this.supabase.getAuthClient();
    const { data, error } = await authClient.auth.getUser(token);
    const authUser = data?.user;

    if (error || !authUser?.id) {
      this.logger.warn(
        `Invalid JWT for ${request.method} ${request.path}: ${error?.message ?? 'missing auth user'}`,
      );
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.prisma.users.findUnique({
      where: { auth_id: authUser.id },
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

    if (!user) {
      this.logger.warn(
        `Authenticated auth_id has no users row: ${authUser.id}`,
      );
      throw new UnauthorizedException('User account not found');
    }

    request.user = this.toRequestUser(user as UserRow);
    return true;
  }

  private extractSessionToken(request: Request): string | null {
    const cookies = parseCookieHeader(request.headers.cookie);
    const cookieToken = cookies.pms_access_token;

    if (cookieToken) {
      return cookieToken;
    }

    if (process.env.ALLOW_BEARER_AUTH === 'true') {
      return this.extractBearerToken(request.headers?.authorization);
    }

    return null;
  }

  private extractBearerToken(header?: string): string | null {
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }
    return token;
  }

  private normalizeRole(role: string | null): Role | null {
    if (role === 'super_admin' || role === 'superadmin')
      return Role.SUPER_ADMIN;
    if (role === 'admin') return Role.ADMIN;
    if (role === 'employee' || role === 'branch') return Role.EMPLOYEE;
    return null;
  }

  private toRequestUser(user: UserRow) {
    if (user.account_status === 'pending') {
      throw new UnauthorizedException('Account pending approval');
    }
    if (user.account_status === 'rejected') {
      throw new UnauthorizedException('Account rejected');
    }

    const role = this.normalizeRole(user.role);
    if (!role) {
      throw new UnauthorizedException('User account role is invalid');
    }

    return {
      id: user.id,
      authId: user.auth_id,
      fullName: user.full_name,
      email: user.email,
      role,
      branchId: user.branch_id,
      branchName: user.branches?.name ?? null,
      avatarUrl: user.avatar_url,
    };
  }
}
