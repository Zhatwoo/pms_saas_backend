import { Module } from '@nestjs/common';
import { FundRequestsController } from './controllers/fund-requests.controller';
import { FundRequestsService } from './services/fund-requests.service';

@Module({
  controllers: [FundRequestsController],
  providers: [FundRequestsService],
  exports: [FundRequestsService],
})
export class FundRequestsModule {}
