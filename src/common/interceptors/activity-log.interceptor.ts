import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ActivityLogsService } from '../../modules/activity-logs/activity-logs.service';

@Injectable()
export class ActivityLogInterceptor implements NestInterceptor {
  constructor(private readonly activityLogsService: ActivityLogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;

    // We only log mutating actions automatically
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const user = request.user;

      const { url, body, params, query } = request;

      return next.handle().pipe(
        tap({
          next: () => {
            // Success
            if (user && user.id) {
              const action = `${method} ${url.split('?')[0]}`;
              const extraDetails =
                request.auditLogContext &&
                typeof request.auditLogContext === 'object' &&
                !Array.isArray(request.auditLogContext)
                  ? request.auditLogContext
                  : {};

              this.activityLogsService.createLog({
                userId: user.id || user.sub,
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
              });
            }
          },
          error: (err) => {
            // We could also log failures, but usually activity log is for successful changes
          },
        }),
      );
    }

    return next.handle();
  }

  private sanitize(body: any) {
    if (!body) return body;
    const sanitized = { ...body };
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
