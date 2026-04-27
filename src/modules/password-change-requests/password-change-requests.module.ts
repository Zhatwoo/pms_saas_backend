import { Module } from '@nestjs/common';
import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { PasswordChangeRequestsController } from './controllers/password-change-requests.controller';
import { PasswordChangeRequestsService } from './services/password-change-requests.service';

@Module({
  imports: [ActivityLogsModule],
  controllers: [PasswordChangeRequestsController],
  providers: [PasswordChangeRequestsService],
})
export class PasswordChangeRequestsModule {}
