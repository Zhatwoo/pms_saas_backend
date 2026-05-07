import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { createValidationPipe } from './common/pipes';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = (
    process.env.CORS_ORIGINS ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000,http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix('api');
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: process.env.NODE_ENV === 'production',
    }),
  );
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');

  // Increase payload limits for Base64 images
  const { json, urlencoded } = require('express');
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
  });

  await app.listen(process.env.PORT ?? 4000, '0.0.0.0');
}
bootstrap();
