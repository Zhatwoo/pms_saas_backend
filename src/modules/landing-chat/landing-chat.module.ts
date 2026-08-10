import { Module } from '@nestjs/common';
import { LandingChatController } from './controllers/landing-chat.controller';
import { LandingChatService } from './services/landing-chat.service';

@Module({
  controllers: [LandingChatController],
  providers: [LandingChatService],
})
export class LandingChatModule {}
