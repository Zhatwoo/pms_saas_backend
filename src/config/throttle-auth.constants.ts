/**
 * Auth-route throttle overrides evaluated at module load time (reads env synchronously).
 * Keeps decorator metadata aligned with THROTTLE_AUTH_* documented in `.env.example`.
 */

function pi(raw: string | undefined, fb: number) {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
}

export const AUTH_STRICT_THROTTLE = {
  global: {
    limit: pi(process.env.THROTTLE_AUTH_LIMIT, 5),
    ttl: pi(process.env.THROTTLE_AUTH_TTL_MS, 900_000),
  },
  burst: {
    limit: pi(process.env.THROTTLE_AUTH_BURST_LIMIT, 5),
    ttl: pi(process.env.THROTTLE_AUTH_BURST_TTL_MS, 60_000),
  },
} as const;
