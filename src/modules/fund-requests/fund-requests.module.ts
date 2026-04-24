import { Module } from '@nestjs/common';
import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FundRequestsController } from './controllers/fund-requests.controller';
import { FundRequestsService } from './services/fund-requests.service';

@Module({
  imports: [ActivityLogsModule, NotificationsModule],
  controllers: [FundRequestsController],
  providers: [FundRequestsService],
  exports: [FundRequestsService],
})
export class FundRequestsModule {}
