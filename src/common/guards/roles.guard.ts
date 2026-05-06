import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../enums/role.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { Request } from 'express';

type RoleRequest = Request & {
  user?: {
    id?: string | null;
    role?: Role | null;
  };
};

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RoleRequest>();
    const { user } = request;

    this.logger.debug({
      path: request.path,
      method: request.method,
      userRole: user?.role,
      requiredRoles,
      hasAccess: requiredRoles.some((role) => user?.role === role),
    });

    const hasAccess = requiredRoles.some((role) => user?.role === role);

    if (!hasAccess) {
      this.logger.warn(
        `Unauthorized role access: ${request.method} ${request.path} user=${user?.id ?? 'unknown'} role=${user?.role ?? 'none'} required=${requiredRoles.join(',')}`,
      );
      throw new ForbiddenException(
        `Access denied. Required roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
