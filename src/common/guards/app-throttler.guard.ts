import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import * as crypto from 'node:crypto';

/**
 * Global rate-limit guard:
 * - Skips OPTIONS so CORS preflight is not counted against quotas (prevents flaky browsers under load).
 * - Logs throttling events without storing raw client IPs (privacy + log safety).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly securityLogger = new Logger('SecurityThrottle');

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    if (req.method === 'OPTIONS') {
      return true;
    }
    return super.shouldSkip(context);
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { req } = this.getRequestResponse(context);
    const pseudoIp = anonymizeTracker(detail.tracker);
    this.securityLogger.warn(
      `Rate limit exceeded: ${req.method} ${req.originalUrl ?? req.url} trackerHash=${pseudoIp} limit=${detail.limit} ttlMs=${detail.ttl}`,
    );
    return super.throwThrottlingException(context, detail);
  }
}

/** One-way fingerprint of tracker string (typically IP); avoids logging raw IPs in security logs. */
function anonymizeTracker(tracker: string): string {
  return crypto.createHash('sha256').update(tracker).digest('hex').slice(0, 16);
}
