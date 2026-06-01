/**
 * One-off stress test: concurrent Prisma queries against the configured pool.
 * Run: node scripts/test-db-pool.mjs
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const CONCURRENCY = 25;
const poolMax = Math.min(
  Number.parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10) || 10,
  15,
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg(pool, { disposeExternalPool: true }),
});

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? '';
  const port = dbUrl.includes(':6543/') ? '6543 (transaction)' : dbUrl.includes(':5432/') ? '5432 (session)' : 'unknown';
  console.log(`DATABASE_URL port: ${port}, pool max: ${poolMax}, concurrency: ${CONCURRENCY}`);

  await prisma.$connect();

  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      prisma.transactions.findMany({
        take: 3,
        orderBy: { created_at: 'desc' },
        include: {
          users: { select: { id: true, full_name: true, role: true } },
          pawned_items: {
            select: { id: true, item_id: true, customers: { select: { id: true, full_name: true } } },
          },
        },
      }).then((rows) => ({ i, count: rows.length })),
    ),
  );

  const failed = results.filter((r) => r.status === 'rejected');
  const ok = results.filter((r) => r.status === 'fulfilled');

  console.log(`Done in ${Date.now() - started}ms — ok: ${ok.length}, failed: ${failed.length}`);
  for (const f of failed) {
    console.error('  ERROR:', f.reason?.message ?? f.reason);
  }

  await prisma.$disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
