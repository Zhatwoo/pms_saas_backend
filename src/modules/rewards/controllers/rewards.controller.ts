import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { RewardsService } from '../services/rewards.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { CreateRewardDto } from '../dto/create-reward.dto';
import { UpdateRewardDto } from '../dto/update-reward.dto';
import { ClaimRewardDto } from '../dto/claim-reward.dto';

@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  /* ──────────── Reward Rules CRUD (Super Admin only) ──────────── */

  @Roles(Role.SUPER_ADMIN)
  @Post()
  createReward(@Body() dto: CreateRewardDto) {
    return this.rewardsService.createReward(dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  updateReward(@Param('id') id: string, @Body() dto: UpdateRewardDto) {
    return this.rewardsService.updateReward(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  deleteReward(@Param('id') id: string) {
    return this.rewardsService.deleteReward(id);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAllRewards(@Query('activeOnly') activeOnly?: string) {
    return this.rewardsService.findAllRewards(activeOnly === 'true');
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id')
  findOneReward(@Param('id') id: string) {
    return this.rewardsService.findOneReward(id);
  }

  /* ──────────── Customer-Specific Rewards ──────────── */

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('customer/:customerId')
  findCustomerRewards(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('customerId') customerId: string,
  ) {
    return this.rewardsService.findCustomerRewards(req.user, customerId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('customer/:customerId/progress')
  getCustomerProgress(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('customerId') customerId: string,
  ) {
    return this.rewardsService.getCustomerProgress(req.user, customerId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('customer-rewards/:customerRewardId/claim')
  claimReward(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('customerRewardId') customerRewardId: string,
    @Body() dto: ClaimRewardDto,
  ) {
    return this.rewardsService.claimReward(
      req.user as AuthenticatedUserProfile & { id: string },
      customerRewardId,
      dto.notes,
    );
  }
}
