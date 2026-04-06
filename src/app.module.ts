import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';

import { RolesGuard } from './common/guards';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { BranchesModule } from './branches/branches.module';
import { ItemsModule } from './items/items.module';
import { TransactionsModule } from './transactions/transactions.module';
import { CategoriesModule } from './categories/categories.module';
import { ReportsModule } from './reports/reports.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    AuthModule,
    UsersModule,
    BranchesModule,
    ItemsModule,
    TransactionsModule,
    CategoriesModule,
    ReportsModule,
    DashboardModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
