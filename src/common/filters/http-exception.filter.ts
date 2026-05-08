import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/** HTTP 413 — used with literal comparisons to satisfy strict ESLint alongside `unknown` middleware errors. */
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** HTTP 429 — rate limiting / quotas. */
const HTTP_TOO_MANY_REQUESTS = 429;

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

/** Payload errors from Express body-parser; avoid surfacing parser internals (stack / limit strings) to clients. */
function isPayloadTooLargeException(exception: unknown): boolean {
  if (exception instanceof HttpException) {
    return exception.getStatus() === HTTP_PAYLOAD_TOO_LARGE;
  }
  if (!exception || typeof exception !== 'object') return false;
  const e = exception as Record<string, unknown>;
  if (e.type === 'entity.too.large') return true;
  if (typeof e.status === 'number' && e.status === HTTP_PAYLOAD_TOO_LARGE) {
    return true;
  }
  if (
    typeof e.statusCode === 'number' &&
    e.statusCode === HTTP_PAYLOAD_TOO_LARGE
  ) {
    return true;
  }
  return false;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Standard contract for abusive traffic / quotas (do not expose internal throttler details).
    if (exception instanceof HttpException) {
      if (exception.getStatus() === HTTP_TOO_MANY_REQUESTS) {
        response.status(HTTP_TOO_MANY_REQUESTS).json({
          success: false,
          message: 'Too many requests. Please try again later.',
        });
        return;
      }
      if (exception.getStatus() === HTTP_PAYLOAD_TOO_LARGE) {
        response.status(HTTP_PAYLOAD_TOO_LARGE).json({
          success: false,
          message: 'Request body is too large.',
        });
        return;
      }
    }

    if (isPayloadTooLargeException(exception)) {
      response.status(HTTP_PAYLOAD_TOO_LARGE).json({
        success: false,
        message: 'Request body is too large.',
      });
      return;
    }

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
    } else if (
      exception instanceof Error &&
      process.env.NODE_ENV !== 'production'
    ) {
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

    this.logger.error(
      `[HttpExceptionFilter] ${status}: ${message}`,
      exception instanceof Error && !(exception instanceof HttpException)
        ? exception.stack
        : '',
    );

    response.status(status).json(errorResponse);
  }
}
