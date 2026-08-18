import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tenantContext } from '../utils/tenant-context.util';

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Fallback if tenantId is not attached directly to the user (e.g. public routes)
    // You could also extract it from a custom header like 'x-tenant-id' if appropriate
    const tenantId = user?.tenantId || request.headers['x-tenant-id'];

    if (tenantId) {
      return tenantContext.run({ tenantId }, () => {
        return next.handle();
      });
    }

    return next.handle();
  }
}
