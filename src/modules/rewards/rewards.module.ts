import { Module } from '@nestjs/common';
import { RewardsController } from './controllers/rewards.controller';
import { RewardsService } from './services/rewards.service';

@Module({
  controllers: [RewardsController],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsModule {}
