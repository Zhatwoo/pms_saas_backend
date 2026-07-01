import { Injectable, Scope } from '@nestjs/common';

/**
 * Request-scoped cache for storing data that should only be cached
 * during a single HTTP request to prevent stale data issues.
 *
 * Example: Branch metadata lookups should be consistent within a request
 * but should refresh on the next request to pick up any updates.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestCacheService {
  private cache = new Map<string, any>();

  get<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get or compute a value from request cache
   */
  getOrCompute<T>(key: string, factory: () => T | Promise<T>): T | Promise<T> {
    if (this.cache.has(key)) {
      return this.cache.get(key) as T;
    }

    const result = factory();

    if (result instanceof Promise) {
      return result.then((value) => {
        this.cache.set(key, value);
        return value;
      });
    }

    this.cache.set(key, result);
    return result;
  }

  createKey(...parts: (string | number)[]): string {
    return parts.join(':');
  }

  clear(): void {
    this.cache.clear();
  }

  getSize(): number {
    return this.cache.size;
  }
}
