import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ResponseShape<T> {
  statusCode: number;
  data: T;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ResponseShape<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ResponseShape<T>> {
    return next.handle().pipe(
      map((data) => ({
        statusCode: context.switchToHttp().getResponse().statusCode,
        data,
      })),
    );
  }
}
