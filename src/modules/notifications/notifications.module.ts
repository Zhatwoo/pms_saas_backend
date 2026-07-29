import { Module, Global } from '@nestjs/common';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationsService } from './services/notifications.service';
import { EmailController } from './controllers/email.controller';
import { ContactController } from './controllers/contact.controller';
import { EmailService } from './services/email.service';
import { NotificationEventsService } from './services/notification-events.service';

@Global()
@Module({
  controllers: [NotificationsController, EmailController, ContactController],
  providers: [NotificationsService, NotificationEventsService, EmailService],
  exports: [NotificationsService, EmailService],
})
export class NotificationsModule {}
