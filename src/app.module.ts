import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import appConfig from './config/app.config';

import { JwtAuthGuard, RolesGuard } from './common/guards';

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

import { ActivityLogInterceptor } from './common/interceptors/activity-log.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
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
      provide: APP_INTERCEPTOR,
      useClass: ActivityLogInterceptor,
    },
  ],
})
export class AppModule {}
