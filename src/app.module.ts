import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import appConfig from './config/app.config';
import securityConfig from './config/security.config';
import { CsrfOriginMiddleware } from './common/middleware/csrf-origin.middleware';

import {
  AppThrottlerGuard,
  JwtAuthGuard,
  OpeningChecklistGuard,
  RolesGuard,
} from './common/guards';

import { SupabaseModule } from './infrastructure/supabase/supabase.module';
import { PrismaModule } from './infrastructure/prisma';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BranchesModule } from './modules/branches/branches.module';
import { ItemsModule } from './modules/items/items.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { ReportsModule } from './modules/reports/reports.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CustomersModule } from './modules/customers/customers.module';
import { PawnTicketsModule } from './modules/pawn-tickets/pawn-tickets.module';
import { ActivityLogsModule } from './modules/activity-logs/activity-logs.module';
import { FundRequestsModule } from './modules/fund-requests/fund-requests.module';
import { BranchFinanceModule } from './modules/branch-finance/branch-finance.module';
import { ShopSettingsModule } from './modules/shop-settings/shop-settings.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PasswordChangeRequestsModule } from './modules/password-change-requests/password-change-requests.module';
import { IncidentTicketsModule } from './modules/incident-tickets/incident-tickets.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { QRReplacementRequestsModule } from './modules/qr-replacement-requests/qr-replacement-requests.module';
import { DevicesModule } from './modules/devices/devices.module';
import { CategoriesModule } from './modules/categories/categories.module';

import { ActivityLogInterceptor } from './common/interceptors/activity-log.interceptor';
import { EncryptionModule } from './common/encryption/encryption.module';
import { CacheModuleConfig } from './infrastructure/cache';
import { AppController } from './app.controller';
import { HealthController } from './modules/health/health.controller';

@Module({
  // Triggering reload for new QR replacement routes
  imports: [
    EncryptionModule,
    CacheModuleConfig,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, securityConfig],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Named throttlers: every request must pass BOTH (steady window + burst).
        throttlers: [
          {
            name: 'global',
            ttl: config.get<number>('security.throttleGlobalTtlMs') ?? 900_000,
            limit: config.get<number>('security.throttleGlobalLimit') ?? 100,
          },
          {
            name: 'burst',
            ttl: config.get<number>('security.throttleBurstTtlMs') ?? 10_000,
            limit: config.get<number>('security.throttleBurstLimit') ?? 25,
          },
        ],
      }),
    }),
    PrismaModule,
    SupabaseModule,
    AuthModule,
    UsersModule,
    BranchesModule,
    ItemsModule,
    TransactionsModule,
    ReportsModule,
    DashboardModule,
    InventoryModule,
    CustomersModule,
    PawnTicketsModule,
    ActivityLogsModule,
    FundRequestsModule,
    BranchFinanceModule,
    ShopSettingsModule,
    NotificationsModule,
    PasswordChangeRequestsModule,
    IncidentTicketsModule,
    RewardsModule,
    QRReplacementRequestsModule,
    DevicesModule,
    CategoriesModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: OpeningChecklistGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ActivityLogInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CsrfOriginMiddleware).forRoutes('*');
  }
}
