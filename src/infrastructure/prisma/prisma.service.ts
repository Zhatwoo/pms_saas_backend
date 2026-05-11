import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sanitizePostgresConnectionStringTimezone } from '../../common/utils/timezone.util';

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
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL via Prisma');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
