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

    const extendedClient = this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
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

            if (tenantId && modelsWithTenant.includes(model)) {
              const a = (args ?? {}) as any;
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
                'findUnique',
                'findUniqueOrThrow',
              ].includes(operation);

              if (isReadOrUpdate) {
                a.where = { ...a.where, tenant_id: tenantId };
              }

              const isCreate = ['create', 'createMany'].includes(operation);
              if (isCreate && a.data) {
                if (operation === 'createMany' && Array.isArray(a.data)) {
                  a.data = a.data.map((d: any) => ({ ...d, tenant_id: tenantId }));
                } else {
                  a.data = { ...a.data, tenant_id: tenantId };
                }
              }
              return query(a);
            }

            return query(args);
          },
        },
      },
    });

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in extendedClient) {
          const val = Reflect.get(extendedClient, prop, extendedClient);
          return typeof val === 'function' ? val.bind(extendedClient) : val;
        }
        return Reflect.get(target, prop, receiver);
      },
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
