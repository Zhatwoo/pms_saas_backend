import { Module } from '@nestjs/common';
import { DashboardController } from './controllers/dashboard.controller';
import { DashboardService } from './services/dashboard.service';
import { ExpirationCronService } from './services/expiration-cron.service';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [DashboardController],
  providers: [DashboardService, ExpirationCronService],
})
export class DashboardModule {}
