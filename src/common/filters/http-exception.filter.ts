import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: any = 'Internal server error';
    let data: any = undefined;

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else {
        const responseObj = exceptionResponse as any;
        message = responseObj.message || 'An error occurred';
        // Include both 'details' and 'errors' to cover all cases
        data = responseObj.details || responseObj.errors || responseObj.error;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    const errorResponse: any = {
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    };

    if (data) {
      errorResponse.data = data;
    }

    console.error(`[HttpExceptionFilter] ${status}:`, errorResponse);
    response.status(status).json(errorResponse);
  }
}
