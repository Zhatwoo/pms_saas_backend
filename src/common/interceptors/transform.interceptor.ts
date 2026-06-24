import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ResponseShape<T> {
  statusCode: number;
  data: T;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ResponseShape<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ResponseShape<T>> {
    const request = context.switchToHttp().getRequest<Request>();
    if (
      request.path === '/' ||
      request.path === '/health' ||
      request.path === '/api/notifications/stream'
    ) {
      return next.handle() as Observable<ResponseShape<T>>;
    }

    return next.handle().pipe(
      map((data) => ({
        statusCode: context.switchToHttp().getResponse().statusCode,
        data,
      })),
    );
  }
}
