import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

@Injectable()
export class CacheService {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async get<T>(key: string): Promise<T | undefined> {
    return await this.cacheManager.get<T>(key);
  }

  async set<T>(
    key: string,
    value: T,
    ttl?: number,
  ): Promise<void> {
    await this.cacheManager.set(key, value, ttl);
  }

  async del(key: string): Promise<void> {
    await this.cacheManager.del(key);
  }

  /**
   * Get or compute a value from cache
   * @param key Cache key
   * @param factory Function to compute value if not cached
   * @param ttl Time to live in milliseconds
   */
  async getOrCompute<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    let value = await this.get<T>(key);

    if (value === undefined) {
      value = await factory();
      await this.set(key, value, ttl);
    }

    return value;
  }

  /**
   * Create a cache key from multiple parts
   */
  createKey(...parts: (string | number)[]): string {
    return parts.join(':');
  }
}
