import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { createValidationPipe } from './common/pipes';
import type { Application, NextFunction, Request, Response } from 'express';
import { json, urlencoded } from 'express';

/** Route prefixes accepting large Base64-in-JSON bodies (pawn, inventory proofs, bulk photos). Must stay higher than general API defaults to avoid breaking uploads. */
const HEAVY_JSON_ROUTE_PREFIXES = [
  '/api/pawn-tickets',
  '/api/inventory',
  '/api/fund-requests',
  '/api/transactions',
];

/**
 * Parses TRUST_PROXY for Express req.ip resolution behind reverse proxies (Vercel, Nginx, Cloudflare ELB).
 * Too permissive in a misconfigured topology lets clients spoof X-Forwarded-For and bypass naive IP quotas.
 */
function resolveTrustProxy(): boolean | number {
  const raw = process.env.TRUST_PROXY;
  if (raw === 'false' || raw === '0') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === undefined || raw === '') {
    return process.env.NODE_ENV === 'production' ? 1 : false;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule);
  const expressApp = app.getHttpAdapter().getInstance() as Application;

  /*
   * trust proxy MUST be configured when the Nest app sits behind HTTPS terminators/CDNs so:
   * - req.ip resolves to client IP → rate limits keyed per real visitor
   * - secure cookies behave when upstream sets X-Forwarded-Proto=https
   * Only enable hop counts you actually have; otherwise spoofed forwarded headers bypass controls.
   */
  expressApp.set('trust proxy', resolveTrustProxy());

  const allowedOrigins = (
    process.env.CORS_ORIGINS ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000,http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix('api');

  /*
   * Helmet raises baseline browser protections on API responses too (MIME sniff / clickjacking / referrer hygiene).
   * CORP stays cross-origin to avoid breaking callers that deliberately mix origins with credentialed cookies.
   * COEP is disabled — strict isolation helps sites with WASM & cross-origin assets, not typical JSON RPC over fetch.
   */
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production'
          ? {
              useDefaults: false,
              directives: {
                defaultSrc: ["'none'"],
                frameAncestors: ["'none'"],
                baseUri: ["'none'"],
              },
            }
          : false,
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts:
        process.env.NODE_ENV === 'production'
          ? { maxAge: 15552000, includeSubDomains: true }
          : false,
      ieNoOpen: false,
      noSniff: true,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  expressApp.disable('x-powered-by');

  const configService = app.get(ConfigService);
  const defaultMb =
    configService.get<number>('security.httpJsonBodyLimitDefaultMb') ?? 1;
  const heavyMb =
    configService.get<number>('security.httpJsonBodyLimitHeavyMb') ?? 20;

  const heavyJson = json({
    limit: `${heavyMb}mb`,
  });
  const defaultJson = json({
    limit: `${defaultMb}mb`,
  });

  /*
   * One JSON parser per request: heavy routes bypass the default ceiling while ordinary routes stay capped (DoS payloads).
   * Order keeps urlencoded capped globally because this API predominantly uses JSON.
   */
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    const pathname = req.path || '';
    const isHeavyRoute = HEAVY_JSON_ROUTE_PREFIXES.some((p) =>
      pathname.startsWith(p),
    );
    (isHeavyRoute ? heavyJson : defaultJson)(req, res, next);
  });
  expressApp.use(urlencoded({ limit: `${defaultMb}mb`, extended: true }));

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
  });

  const port =
    configService.get<number>('port') ??
    parseInt(process.env.PORT ?? '4000', 10) ??
    4000;
  await app.listen(port, '0.0.0.0');
  logger.log(`Listening on ${port}`);
}
void bootstrap().catch((err: unknown) => {
  const log = new Logger('Bootstrap');
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
