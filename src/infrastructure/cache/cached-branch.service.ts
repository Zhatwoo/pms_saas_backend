import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  async findUnique<S extends Prisma.branchesSelect | undefined = undefined>(
    branchId: string,
    select?: S,
  ) {
    type Result = Prisma.branchesGetPayload<{ select: S }>;

    const cacheKey = this.requestCache.createKey(
      'branch',
      branchId,
      JSON.stringify(select || {}),
    );

    // Check request cache first
    const cached = this.requestCache.get<Result | null>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Fall back to database
    const result = (await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: select ?? (true as unknown as S),
    })) as Result | null;

    // Cache in request scope if found
    if (result) {
      this.requestCache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Find branches by ID list with caching
   */
  async findMany<S extends Prisma.branchesSelect | undefined = undefined>(
    branchIds: string[],
    select?: S,
  ) {
    const results: Prisma.branchesGetPayload<{ select: S }>[] = [];

    for (const id of branchIds) {
      const result = await this.findUnique(id, select);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }
}
