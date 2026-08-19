import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export interface PublicPlanLimit {
  branchLimit: number;
  userLimit: number;
  storageGb: number;
}

export interface PublicPlanAddon {
  id: string;
  name: string;
  price: number;
  unit: string;
}

export interface PublicPlanDto {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  badge?: string | null;
  isPopular: boolean;
  isDefault: boolean;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  billingType: 'monthly' | 'annual' | 'both';
  trialEnabled: boolean;
  trialDays: number;
  limits: PublicPlanLimit | null;
  features: string[];
  inclusions: string[];
  addons: PublicPlanAddon[];
}

export interface PublicPlansResponse {
  plans: PublicPlanDto[];
}

const DEFAULT_ADMIN_DB_URL =
  'postgresql://postgres.cojwxieosgsqmwubitoq:%40Inspire2026%21@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

@Injectable()
export class SubscriptionsService implements OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsService.name);
  private adminPrisma: PrismaClient | null = null;

  // In-memory cache for fast response and real-time freshness (20 seconds TTL)
  private cachedResponse: PublicPlansResponse | null = null;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs = 20_000;

  async onModuleDestroy() {
    if (this.adminPrisma) {
      try {
        await this.adminPrisma.$disconnect();
      } catch {
        // ignore
      }
      this.adminPrisma = null;
    }
  }

  /**
   * Returns public subscription plans for the SaaS landing page.
   * 1. Check in-memory cache.
   * 2. Try fetching from PMS Admin backend HTTP API if configured.
   * 3. Fallback to direct Admin DB query (Supabase Postgres) via PrismaPg.
   */
  async getPublicLandingPlans(): Promise<PublicPlansResponse> {
    const now = Date.now();
    if (this.cachedResponse && now < this.cacheExpiresAt) {
      return this.cachedResponse;
    }

    // Step 1: Try PMS Admin HTTP backend if configured
    const adminBackendUrl = process.env.ADMIN_BACKEND_URL;
    if (adminBackendUrl) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);

        const res = await fetch(`${adminBackendUrl}/api/public/plans`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = (await res.json()) as PublicPlansResponse;
          if (data && Array.isArray(data.plans) && data.plans.length > 0) {
            this.setCache(data);
            return data;
          }
        }
      } catch (err: any) {
        this.logger.debug(
          `Could not reach PMS Admin backend (${adminBackendUrl}): ${err?.message ?? err}. Falling back to direct database query.`,
        );
      }
    }

    // Step 2: Query PMS Admin Database directly
    try {
      const data = await this.fetchPlansFromAdminDb();
      if (data && data.plans.length > 0) {
        this.setCache(data);
        return data;
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to fetch subscription plans from Admin DB: ${err?.message ?? err}`,
        err?.stack,
      );
    }

    return this.cachedResponse || { plans: [] };
  }

  private setCache(data: PublicPlansResponse) {
    this.cachedResponse = data;
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
  }

  private getAdminPrisma(): PrismaClient {
    if (!this.adminPrisma) {
      const connectionString =
        process.env.ADMIN_DATABASE_URL || DEFAULT_ADMIN_DB_URL;
      this.adminPrisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
        log: ['warn', 'error'],
      });
    }
    return this.adminPrisma;
  }

  private async fetchPlansFromAdminDb(): Promise<PublicPlansResponse> {
    const client = this.getAdminPrisma();

    // 1. Fetch active plans visible on landing
    const plans = await client.$queryRawUnsafe<any[]>(`
      SELECT id, name, slug, description, is_default, is_popular
      FROM subscription_plans
      WHERE is_active = true 
        AND (visible_on_landing IS NULL OR visible_on_landing = true)
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `);

    if (!plans || plans.length === 0) {
      return { plans: [] };
    }

    // 2. Fetch latest active version for each plan
    const planIds = plans.map((p) => p.id);
    const versions = await client.$queryRawUnsafe<any[]>(
      `
      SELECT DISTINCT ON (plan_id)
        id, plan_id, version_number, monthly_price, annual_price, 
        currency, billing_type, trial_enabled, trial_days, 
        branch_limit, user_limit, storage_gb
      FROM subscription_plan_versions
      WHERE plan_id = ANY($1::text[]) AND is_active = true
      ORDER BY plan_id, version_number DESC
    `,
      planIds,
    );

    const versionMap = new Map<string, any>(
      versions.map((v) => [v.plan_id, v]),
    );
    const versionIds = versions.map((v) => v.id);

    const featuresMap = new Map<string, string[]>();
    const inclusionsMap = new Map<string, string[]>();
    const addonsMap = new Map<string, PublicPlanAddon[]>();

    if (versionIds.length > 0) {
      const features = await client.$queryRawUnsafe<any[]>(
        `
        SELECT id, plan_version_id, name, enabled, display_order
        FROM subscription_plan_features
        WHERE plan_version_id = ANY($1::text[]) AND (enabled IS NULL OR enabled = true)
        ORDER BY display_order ASC
      `,
        versionIds,
      );
      for (const f of features) {
        if (!featuresMap.has(f.plan_version_id)) {
          featuresMap.set(f.plan_version_id, []);
        }
        featuresMap.get(f.plan_version_id)!.push(f.name);
      }

      const inclusions = await client.$queryRawUnsafe<any[]>(
        `
        SELECT id, plan_version_id, name, display_order
        FROM subscription_plan_inclusions
        WHERE plan_version_id = ANY($1::text[])
        ORDER BY display_order ASC
      `,
        versionIds,
      );
      for (const inc of inclusions) {
        if (!inclusionsMap.has(inc.plan_version_id)) {
          inclusionsMap.set(inc.plan_version_id, []);
        }
        inclusionsMap.get(inc.plan_version_id)!.push(inc.name);
      }

      const addons = await client.$queryRawUnsafe<any[]>(
        `
        SELECT id, plan_version_id, name, price, unit, enabled, display_order
        FROM subscription_plan_addons
        WHERE plan_version_id = ANY($1::text[]) AND (enabled IS NULL OR enabled = true)
        ORDER BY display_order ASC
      `,
        versionIds,
      );
      for (const a of addons) {
        if (!addonsMap.has(a.plan_version_id)) {
          addonsMap.set(a.plan_version_id, []);
        }
        addonsMap.get(a.plan_version_id)!.push({
          id: a.id,
          name: a.name,
          price: Number(a.price) || 0,
          unit: a.unit || '/mo',
        });
      }
    }

    const formattedPlans: PublicPlanDto[] = plans.map((p) => {
      const v = versionMap.get(p.id);
      const verFeatures = v ? featuresMap.get(v.id) || [] : [];
      const verInclusions = v ? inclusionsMap.get(v.id) || [] : [];
      const verAddons = v ? addonsMap.get(v.id) || [] : [];

      // Synthesize clean feature items if needed
      const featureList = [...verFeatures];
      if (v) {
        if (
          v.branch_limit &&
          !featureList.some((f) => f.toLowerCase().includes('branch'))
        ) {
          featureList.unshift(
            `${v.branch_limit} ${v.branch_limit === 1 ? 'Branch' : 'Branches'}`,
          );
        }
        if (
          v.user_limit &&
          !featureList.some((f) => f.toLowerCase().includes('user'))
        ) {
          featureList.push(`Up to ${v.user_limit} Users`);
        }
        if (
          v.storage_gb &&
          !featureList.some(
            (f) =>
              f.toLowerCase().includes('storage') ||
              f.toLowerCase().includes('gb'),
          )
        ) {
          featureList.push(`${v.storage_gb}GB Storage`);
        }
        if (
          v.trial_enabled &&
          v.trial_days &&
          !featureList.some((f) => f.toLowerCase().includes('trial'))
        ) {
          featureList.push(`Free Trial (${v.trial_days} days)`);
        }
      }

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        isPopular: Boolean(p.is_popular),
        isDefault: Boolean(p.is_default),
        monthlyPrice: v ? Number(v.monthly_price) || 0 : 0,
        annualPrice: v ? Number(v.annual_price) || 0 : 0,
        currency: v?.currency || 'PHP',
        billingType: (v?.billing_type as any) || 'both',
        trialEnabled: Boolean(v?.trial_enabled),
        trialDays: v?.trial_days || 0,
        limits: v
          ? {
              branchLimit: v.branch_limit,
              userLimit: v.user_limit,
              storageGb: Number(v.storage_gb) || 0,
            }
          : null,
        features: featureList,
        inclusions: verInclusions,
        addons: verAddons,
      };
    });

    return { plans: formattedPlans };
  }
}
