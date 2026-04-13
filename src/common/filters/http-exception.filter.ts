import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';

function normalizeErrorMessage(payload: string | object): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    const m = body.message;
    if (typeof m === 'string') {
      return m;
    }
    if (Array.isArray(m)) {
      return m.map(String).join('; ');
    }
    if (typeof body.error === 'string') {
      return body.error;
    }
  }
  return 'Internal server error';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawMessage =
      exception instanceof HttpException
        ? exception.getResponse()
        : exception instanceof Error
          ? exception.message
          : 'Internal server error';

    let message = normalizeErrorMessage(
      typeof rawMessage === 'string' || typeof rawMessage === 'object'
        ? rawMessage
        : 'Internal server error',
    );
    message = message.trim() || 'Internal server error';

    const errorResponse: Record<string, unknown> = {
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    };

    if (
      exception instanceof HttpException &&
      typeof rawMessage === 'object' &&
      rawMessage !== null &&
      !Array.isArray(rawMessage)
    ) {
      const body = rawMessage as Record<string, unknown>;
      if (body.data !== undefined) {
        errorResponse.data = body.data;
      }
    }

    console.error(`[HttpExceptionFilter] ${status}:`, errorResponse);
    response.status(status).json(errorResponse);
  }
}
