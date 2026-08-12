import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators';
import { LandingChatDto } from '../dto/landing-chat.dto';
import { LandingChatService } from '../services/landing-chat.service';

/** Landing chat — stricter than general API, looser than auth routes. */
const LANDING_CHAT_THROTTLE = {
  global: { limit: 40, ttl: 900_000 },
  burst: { limit: 8, ttl: 60_000 },
} as const;

@Controller('chat')
export class LandingChatController {
  constructor(private readonly landingChatService: LandingChatService) {}

  @Public()
  @Throttle(LANDING_CHAT_THROTTLE)
  @Post('landing')
  async chat(@Body() dto: LandingChatDto) {
    return this.landingChatService.reply(dto.message, dto.history ?? []);
  }
}
