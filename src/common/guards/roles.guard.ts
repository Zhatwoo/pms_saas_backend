import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../enums/role.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    const request = context.switchToHttp().getRequest();
    
    console.log('[RolesGuard] Check:', {
      path: request.path,
      method: request.method,
      userRole: user?.role,
      requiredRoles,
      hasAccess: requiredRoles.some((role) => user?.role === role),
    });

    const hasAccess = requiredRoles.some((role) => user?.role === role);
    
    if (!hasAccess) {
      throw new ForbiddenException(
        `Access denied. Required roles: ${requiredRoles.join(', ')}, Your role: ${user?.role || 'none'}`,
      );
    }

    return true;
  }
}
