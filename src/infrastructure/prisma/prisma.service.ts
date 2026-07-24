import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sanitizePostgresConnectionStringTimezone } from '../../common/utils/timezone.util';
import { getTenantId } from '../../common/utils/tenant-context.util';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for Prisma');
    }

    const { url: safeConnectionString, changed } =
      sanitizePostgresConnectionStringTimezone(connectionString);
    if (changed) {
      new Logger(PrismaService.name).warn(
        'DATABASE_URL used a non-PostgreSQL timezone label (e.g. GMT+0800); connection string was normalized before connect.',
      );
    }

    super({
      adapter: new PrismaPg({ connectionString: safeConnectionString }),
      log:
        process.env.NODE_ENV === 'production'
          ? ['warn', 'error']
          : ['query', 'warn', 'error'],
    });

    this.$use(async (params, next) => {
      const tenantId = getTenantId();
      const modelsWithTenant = [
        'users',
        'branches',
        'customers',
        'transactions',
        'pawned_items',
        'activity_logs',
        'tenant_subscriptions',
      ];

      if (tenantId && modelsWithTenant.includes(params.model as string)) {
        if (!params.args) {
          params.args = {};
        }

        const isReadOrUpdate = [
          'findFirst',
          'findMany',
          'update',
          'updateMany',
          'delete',
          'deleteMany',
          'count',
          'aggregate',
          'groupBy',
        ].includes(params.action);

        if (isReadOrUpdate) {
          params.args.where = { ...params.args.where, tenant_id: tenantId };
        }

        // findUnique can only filter by unique fields. Change to findFirst.
        if (params.action === 'findUnique' || params.action === 'findUniqueOrThrow') {
          params.action = params.action === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
          params.args.where = { ...params.args.where, tenant_id: tenantId };
        }

        const isCreate = ['create', 'createMany'].includes(params.action);
        if (isCreate) {
          if (params.action === 'createMany') {
            if (Array.isArray(params.args.data)) {
              params.args.data = params.args.data.map((d: any) => ({ ...d, tenant_id: tenantId }));
            } else {
              params.args.data = { ...params.args.data, tenant_id: tenantId };
            }
          } else {
            params.args.data = { ...params.args.data, tenant_id: tenantId };
          }
        }
      }

      return next(params);
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL via Prisma');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
