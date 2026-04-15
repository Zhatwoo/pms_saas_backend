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
    if (sanitized.password) sanitized.password = '***';
    if (sanitized.token) sanitized.token = '***';
    return sanitized;
  }
}
