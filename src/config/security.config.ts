/**
 * Rate limit and HTTP hardening knobs (non-secret).
 * Centralises env parsing so ThrottlerModule and docs stay aligned.
 */

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default () => ({
  security: {
    // Long window: default 100 requests / 15 minutes per IP (global API abuse / DDoS-ish volume).
    throttleGlobalLimit: parsePositiveInt(
      process.env.THROTTLE_GLOBAL_LIMIT,
      100,
    ),
    throttleGlobalTtlMs: parsePositiveInt(
      process.env.THROTTLE_GLOBAL_TTL_MS,
      900_000,
    ),
    // Short window: dampens rapid spikes and simple bot floods without replacing a WAF.
    throttleBurstLimit: parsePositiveInt(process.env.THROTTLE_BURST_LIMIT, 25),
    throttleBurstTtlMs: parsePositiveInt(
      process.env.THROTTLE_BURST_TTL_MS,
      10_000,
    ),
    // Credential-sensitive routes: 5 / 15 min (brute-force resistance).
    throttleAuthLimit: parsePositiveInt(process.env.THROTTLE_AUTH_LIMIT, 5),
    throttleAuthTtlMs: parsePositiveInt(
      process.env.THROTTLE_AUTH_TTL_MS,
      900_000,
    ),
    throttleAuthBurstLimit: parsePositiveInt(
      process.env.THROTTLE_AUTH_BURST_LIMIT,
      5,
    ),
    throttleAuthBurstTtlMs: parsePositiveInt(
      process.env.THROTTLE_AUTH_BURST_TTL_MS,
      60_000,
    ),
    // Scoped JSON parsers: default tight; heavy routes use HTTP_JSON_BODY_LIMIT_HEAVY.
    httpJsonBodyLimitDefaultMb: parsePositiveInt(
      process.env.HTTP_JSON_BODY_LIMIT_DEFAULT_MB,
      1,
    ),
    httpJsonBodyLimitHeavyMb: parsePositiveInt(
      process.env.HTTP_JSON_BODY_LIMIT_HEAVY_MB,
      20,
    ),
  },
});
