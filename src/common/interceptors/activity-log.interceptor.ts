import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ActivityLogsService } from '../../modules/activity-logs/activity-logs.service';
import { getEnvironment } from '../utils/authorization.util';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';

interface RequestUser extends Partial<AuthenticatedUserProfile> {
  id?: string;
  sub?: string;
}

interface ActivityLogRequest extends Request {
  user?: RequestUser;
  auditLogContext?: Record<string, unknown>;
}

@Injectable()
export class ActivityLogInterceptor implements NestInterceptor {
  constructor(private readonly activityLogsService: ActivityLogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ActivityLogRequest>();
    const method = request.method;

    // We only log mutating actions automatically
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const user = request.user;

      const { url, params, query } = request;
      const body = request.body as Record<string, unknown> | undefined;

      return next.handle().pipe(
        tap({
          next: () => {
            // Success
            if (user && (user.id || user.sub)) {
              const action = `${method} ${url.split('?')[0]}`;
              const extraDetails =
                request.auditLogContext &&
                typeof request.auditLogContext === 'object' &&
                !Array.isArray(request.auditLogContext)
                  ? request.auditLogContext
                  : {};

              this.activityLogsService
                .createLog({
                  userId: (user.id ?? user.sub) as string,
                  authId: user.authId ?? null,
                  environment: user.email
                    ? getEnvironment({
                        email: user.email,
                        isDeveloper: user.isDeveloper,
                      })
                    : undefined,
                  branchId: user.branchId || null,
                  action: action,
                  details: {
                    method,
                    url,
                    body: this.sanitize(body),
                    params,
                    query,
                    ...extraDetails,
                  },
                })
                .catch((err: unknown) => {
                  console.error('Failed to write activity log:', err);
                });
            }
          },
          error: () => {
            // We could also log failures, but usually activity log is for successful changes
          },
        }),
      );
    }

    return next.handle();
  }

  private sanitize(
    body: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!body) return body;
    const sanitized: Record<string, unknown> = { ...body };
    for (const key of [
      'password',
      'currentPassword',
      'newPassword',
      'token',
      'access_token',
      'refresh_token',
      'serviceRoleKey',
    ]) {
      if (sanitized[key]) sanitized[key] = '***';
    }
    return sanitized;
  }
}
