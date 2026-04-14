import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

function extractMessage(payload: unknown): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const body = payload as Record<string, unknown>;

    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message.trim();
    }
    if (Array.isArray(body.message) && body.message.length > 0) {
      return body.message.map(String).join('; ');
    }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim();
    }
  }

  return '';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let extraData: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const raw = exception.getResponse();
      const extracted = extractMessage(raw);
      message = extracted || exception.message || 'Internal server error';

      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const body = raw as Record<string, unknown>;
        if (body.data !== undefined) {
          extraData = body.data;
        }
        if (body.details !== undefined) {
          extraData = body.details;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message?.trim() || 'Internal server error';
    }

    const errorResponse: Record<string, unknown> = {
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    };

    if (extraData !== undefined) {
      errorResponse.data = extraData;
    }

    console.error(
      `[HttpExceptionFilter] ${status}:`,
      message,
      exception instanceof Error && !(exception instanceof HttpException)
        ? exception.stack
        : '',
    );

    response.status(status).json(errorResponse);
  }
}
