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
import { EncryptionService } from '../encryption/encryption.service';
import { isDeveloper } from '../utils/authorization.util';
import type { Request } from 'express';
import * as crypto from 'node:crypto';

type UserRow = {
  id: string;
  auth_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  branch_id: string | null;
  avatar_url: string | null;
  account_status: string | null;
  is_developer: boolean | null;
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
  isDeveloper: boolean;
};

type AuthenticatedRequest = Request & { user?: RequestUser };

type AuthCredential =
  | { type: 'jwt'; source: 'cookie' | 'bearer'; token: string }
  | { type: 'api-key'; key: string };

const UNAUTHORIZED_RESPONSE = {
  statusCode: 401,
  message: 'Unauthorized request',
  error: 'Unauthorized',
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic || this.isKnownPublicRoute(request)) {
      return true;
    }

    this.logAuthIndicators(request);

    const credential = this.extractCredential(request);
    if (!credential) {
      this.throwUnauthorized(request, 'Missing authentication credential');
    }

    if (credential.type === 'api-key') {
      if (!this.isValidApiKey(credential.key)) {
        this.throwUnauthorized(request, 'Invalid API key');
      }

      request.user = this.createApiKeyUser();
      return true;
    }

    const authClient = this.supabase.getAuthClient();
    const { data, error } = await authClient.auth.getUser(credential.token);
    const authUser = data?.user;

    if (error || !authUser?.id) {
      this.logger.warn(
        `Invalid JWT for ${request.method} ${request.path}: ${error?.message ?? 'missing auth user'}`,
      );
      this.throwUnauthorized(request, 'Invalid JWT');
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
        is_developer: true,
        branches: { select: { name: true } },
      },
    });

    if (!user) {
      this.logger.warn(
        `Authenticated auth_id has no users row: ${authUser.id}`,
      );
      this.throwUnauthorized(request, 'Authenticated user row not found');
    }

    request.user = this.toRequestUser(user);
    request.user.isDeveloper =
      request.user.isDeveloper || isDeveloper({ email: authUser.email });
    return true;
  }

  private isKnownPublicRoute(request: Request): boolean {
    const method = (request.method ?? '').toUpperCase();
    const path = String(
      request.originalUrl ?? request.url ?? request.path ?? '',
    ).split('?')[0];
    const normalizedPath = path.replace(/^\/api(?=\/)/, '');

    if (method === 'OPTIONS') {
      return true;
    }

    return (
      (method === 'POST' &&
        ['/auth/login', '/auth/register', '/auth/logout'].includes(
          normalizedPath,
        )) ||
      (method === 'GET' && normalizedPath === '/auth/signup/branches') ||
      (method === 'POST' && normalizedPath === '/devices/request-authorization')
    );
  }

  private extractCredential(request: Request): AuthCredential | null {
    const apiKey = this.extractApiKey(request);
    if (apiKey) {
      return { type: 'api-key', key: apiKey };
    }

    const cookies = parseCookieHeader(request.headers.cookie);
    const cookieToken = cookies.pms_access_token;

    if (cookieToken) {
      return { type: 'jwt', source: 'cookie', token: cookieToken };
    }

    const bearerToken = this.extractBearerToken(request.headers?.authorization);
    if (bearerToken && process.env.ALLOW_BEARER_AUTH !== 'false') {
      return { type: 'jwt', source: 'bearer', token: bearerToken };
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

  private extractApiKey(request: Request): string | null {
    const raw = request.headers['x-api-key'];
    const apiKey = Array.isArray(raw) ? raw[0] : raw;
    return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
  }

  private isValidApiKey(apiKey: string): boolean {
    const configuredKeys = this.getConfiguredApiKeys();
    if (configuredKeys.length === 0) {
      return false;
    }

    return configuredKeys.some((configuredKey) =>
      this.secureCompare(configuredKey, apiKey),
    );
  }

  private getConfiguredApiKeys(): string[] {
    return [
      ...(process.env.API_KEYS ?? '').split(','),
      process.env.API_KEY ?? '',
      ...(process.env.PMS_API_KEYS ?? '').split(','),
      process.env.PMS_API_KEY ?? '',
    ]
      .map((key) => key.trim())
      .filter(Boolean);
  }

  private secureCompare(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  private createApiKeyUser(): RequestUser {
    return {
      id: 'api-key',
      authId: 'api-key',
      fullName: 'API Key',
      email: 'api-key@system.local',
      role: this.resolveApiKeyRole(),
      branchId: process.env.API_KEY_BRANCH_ID || null,
      branchName: null,
      avatarUrl: null,
      isDeveloper: false,
    };
  }

  private resolveApiKeyRole(): Role {
    return (
      this.normalizeRole(process.env.API_KEY_ROLE ?? null) ?? Role.EMPLOYEE
    );
  }

  private logAuthIndicators(request: Request): void {
    if (process.env.AUTH_DEBUG !== 'true') {
      return;
    }

    const cookies = parseCookieHeader(request.headers.cookie);
    this.logger.warn(
      `Auth debug ${request.method} ${request.path}: hasCookie=${Boolean(cookies.pms_access_token)} hasBearer=${Boolean(this.extractBearerToken(request.headers?.authorization))} hasApiKey=${Boolean(this.extractApiKey(request))} origin=${String(request.headers.origin ?? '')}`,
    );
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
      throw new UnauthorizedException(UNAUTHORIZED_RESPONSE);
    }
    if (user.account_status === 'rejected') {
      throw new UnauthorizedException(UNAUTHORIZED_RESPONSE);
    }

    const role = this.normalizeRole(user.role);
    if (!role) {
      throw new UnauthorizedException(UNAUTHORIZED_RESPONSE);
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
      isDeveloper:
        Boolean(user.is_developer) ||
        user.email.trim().toLowerCase().endsWith('@dev.com'),
    };
  }

  private throwUnauthorized(request: Request, reason: string): never {
    this.logger.warn(
      `${reason} for ${request.method} ${request.originalUrl ?? request.path}`,
    );
    throw new UnauthorizedException(UNAUTHORIZED_RESPONSE);
  }
}
