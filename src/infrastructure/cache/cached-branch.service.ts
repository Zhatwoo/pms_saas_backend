import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestCacheService } from './request-cache.service';

/**
 * Wraps Prisma branch queries with request-scoped caching.
 * This prevents repeated branch lookups within a single HTTP request.
 */
@Injectable()
export class CachedBranchService {
  constructor(
    private prisma: PrismaService,
    private requestCache: RequestCacheService,
  ) {}

  /**
   * Find a branch by ID with request-scoped caching
   */
  async findUnique(branchId: string, select?: any) {
    const cacheKey = this.requestCache.createKey(
      'branch',
      branchId,
      JSON.stringify(select || {}),
    );

    // Check request cache first
    let result = this.requestCache.get(cacheKey);
    if (result !== undefined) {
      return result;
    }

    // Fall back to database
    result = await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: select || true,
    });

    // Cache in request scope if found
    if (result) {
      this.requestCache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Find branches by ID list with caching
   */
  async findMany(branchIds: string[], select?: any) {
    const results: any[] = [];

    for (const id of branchIds) {
      const result = await this.findUnique(id, select);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }
}
