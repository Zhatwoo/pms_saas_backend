import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { PublicPlansController } from './public-plans.controller';

@Module({
  providers: [SubscriptionsService],
  controllers: [SubscriptionsController, PublicPlansController],
})
export class SubscriptionsModule {}
