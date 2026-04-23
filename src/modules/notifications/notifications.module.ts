import { Module, Global } from '@nestjs/common';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationsService } from './services/notifications.service';
import { EmailController } from './controllers/email.controller';
import { EmailService } from './services/email.service';

@Global()
@Module({
  controllers: [NotificationsController, EmailController],
  providers: [NotificationsService, EmailService],
  exports: [NotificationsService, EmailService],
})
export class NotificationsModule {}
