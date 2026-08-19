import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { SubscriptionsService } from './subscriptions.service';

@Controller('public/plans')
export class PublicPlansController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Public()
  @Get()
  async getPublicPlans() {
    return this.subscriptionsService.getPublicLandingPlans();
  }
}
