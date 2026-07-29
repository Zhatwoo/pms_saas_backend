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

const TENANT_SCOPED_MODELS = [
  'users',
  'branches',
  'customers',
  'transactions',
  'pawned_items',
  'activity_logs',
  'tenant_subscriptions',
];

const READ_OR_UPDATE_OPERATIONS = [
  'findFirst',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
];

const CREATE_OPERATIONS = ['create', 'createMany'];

function withTenantScope() {
  return {
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const tenantId = getTenantId();

          if (!tenantId || !TENANT_SCOPED_MODELS.includes(model)) {
            return query(args);
          }

          if (READ_OR_UPDATE_OPERATIONS.includes(operation)) {
            args.where = { ...args.where, tenant_id: tenantId };
          }

          // findUnique can only filter by unique fields, so it cannot take
          // an additional tenant_id constraint directly. Fall back to the
          // findFirst/findFirstOrThrow variant, which supports arbitrary
          // where clauses, to enforce tenant isolation.
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            args.where = { ...args.where, tenant_id: tenantId };
            return (this as any)[operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow'](args);
          }

          if (CREATE_OPERATIONS.includes(operation)) {
            if (operation === 'createMany' && Array.isArray(args.data)) {
              args.data = args.data.map((d: any) => ({ ...d, tenant_id: tenantId }));
            } else {
              args.data = { ...args.data, tenant_id: tenantId };
            }
          }

          return query(args);
        },
      },
    },
  };
}

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

    return this.$extends(withTenantScope()) as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL via Prisma');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
