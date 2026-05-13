import { Module, Global } from '@nestjs/common';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { CacheService } from './cache.service';
import { RequestCacheService } from './request-cache.service';
import { CachedBranchService } from './cached-branch.service';
import { PrismaModule } from '../prisma';

/**
 * Global cache module with optional Redis support.
 * Falls back to in-memory cache if Redis is not configured.
 */
@Global()
@Module({
  imports: [
    NestCacheModule.register({
      isGlobal: true,
      ttl: 300, // 5 minutes default
      // Redis configuration can be added here if needed:
      // host: process.env.REDIS_HOST || 'localhost',
      // port: parseInt(process.env.REDIS_PORT || '6379', 10),
    }),
    PrismaModule,
  ],
  providers: [CacheService, RequestCacheService, CachedBranchService],
  exports: [CacheService, RequestCacheService, CachedBranchService],
})
export class CacheModuleConfig {}
