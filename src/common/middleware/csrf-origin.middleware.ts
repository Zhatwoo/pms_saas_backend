import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  private readonly allowedOrigins: Set<string>;

  constructor() {
    this.allowedOrigins = new Set(
      (
        process.env.CORS_ORIGINS ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000,http://localhost:3001'
      )
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
  }

  use(req: Request, _res: Response, next: NextFunction) {
    if (SAFE_METHODS.has(req.method)) {
      return next();
    }

    if (this.isPublicAuthPath(req.path)) {
      return next();
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const source = typeof origin === 'string' && origin ? origin : referer;

    if (!source) {
      throw new ForbiddenException('Missing request origin');
    }

    let requestOrigin: string;
    try {
      requestOrigin = new URL(source).origin;
    } catch {
      throw new ForbiddenException('Invalid request origin');
    }

    if (!this.allowedOrigins.has(requestOrigin)) {
      throw new ForbiddenException('Request origin is not allowed');
    }

    return next();
  }

  private isPublicAuthPath(path: string): boolean {
    return (
      path === '/api/auth/login' ||
      path === '/api/auth/register' ||
      path === '/api/auth/signup/branches'
    );
  }
}
