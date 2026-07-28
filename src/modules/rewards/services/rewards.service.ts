import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  applyEnvironmentFilter,
  buildBranchFilter,
  environmentCreateFields,
  isSuperAdmin,
} from '../../../common/utils/authorization.util';
import { CreateRewardDto } from '../dto/create-reward.dto';
import { UpdateRewardDto } from '../dto/update-reward.dto';

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* ───────────────────────── Reward Rules CRUD ───────────────────────── */

  async createReward(user: UserWithBranch, dto: CreateRewardDto) {
    return this.prisma.rewards.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() ?? '',
        reward_type: dto.reward_type ?? 'discount',
        reward_value: dto.reward_value,
        required_transaction_count: dto.required_transaction_count,
        required_total_amount: dto.required_total_amount ?? 0,
        transaction_type: dto.transaction_type?.trim() || null,
        is_active: dto.is_active ?? true,
        ...environmentCreateFields(user),
      },
    });
  }

  async updateReward(user: UserWithBranch, id: string, dto: UpdateRewardDto) {
    const existing = await this.prisma.rewards.findFirst({
      where: applyEnvironmentFilter(user, { id }),
    });
    if (!existing) throw new NotFoundException('Reward not found');

    return this.prisma.rewards.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.description !== undefined && {
          description: dto.description.trim(),
        }),
        ...(dto.reward_type !== undefined && {
          reward_type: dto.reward_type,
        }),
        ...(dto.reward_value !== undefined && {
          reward_value: dto.reward_value,
        }),
        ...(dto.required_transaction_count !== undefined && {
          required_transaction_count: dto.required_transaction_count,
        }),
        ...(dto.required_total_amount !== undefined && {
          required_total_amount: dto.required_total_amount,
        }),
        ...(dto.transaction_type !== undefined && {
          transaction_type: dto.transaction_type?.trim() || null,
        }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        updated_at: new Date(),
      },
    });
  }

  async deleteReward(user: UserWithBranch, id: string) {
    const existing = await this.prisma.rewards.findFirst({
      where: applyEnvironmentFilter(user, { id }),
    });
    if (!existing) throw new NotFoundException('Reward not found');

    // Soft-disable instead of hard delete if customer_rewards exist
    const usageCount = await this.prisma.customer_rewards.count({
      where: applyEnvironmentFilter(user, { reward_id: id }),
    });

    if (usageCount > 0) {
      await this.prisma.rewards.update({
        where: { id },
        data: { is_active: false, updated_at: new Date() },
      });
      return { message: 'Reward deactivated (has existing claims)' };
    }

    await this.prisma.rewards.delete({ where: { id } });
    return { message: 'Reward deleted' };
  }

  async findAllRewards(user: UserWithBranch, activeOnly = false) {
    const where: Prisma.rewardsWhereInput = activeOnly
      ? applyEnvironmentFilter(user, { is_active: true })
      : applyEnvironmentFilter(user);
    return this.prisma.rewards.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  async findOneReward(user: UserWithBranch, id: string) {
    const reward = await this.prisma.rewards.findFirst({
      where: applyEnvironmentFilter(user, { id }),
    });
    if (!reward) throw new NotFoundException('Reward not found');
    return reward;
  }

  /* ───────────── Customer Rewards (earned / claimed) ───────────── */

  async findCustomerRewards(user: UserWithBranch, customerId: string) {
    const where: Prisma.customer_rewardsWhereInput = {
      customer_id: customerId,
      ...applyEnvironmentFilter(user),
      ...(!isSuperAdmin(user) ? buildBranchFilter(user) : {}),
    };

    const rewards = await this.prisma.customer_rewards.findMany({
      where,
      include: {
        rewards: true,
      },
      orderBy: { earned_at: 'desc' },
    });

    return rewards.map((cr) => ({
      id: cr.id,
      reward_id: cr.reward_id,
      name: cr.rewards.name,
      description: cr.rewards.description,
      reward_type: cr.rewards.reward_type,
      reward_value: Number(cr.rewards.reward_value),
      status: cr.status,
      earned_at: cr.earned_at,
      claimed_at: cr.claimed_at,
      notes: cr.notes,
    }));
  }

  async claimReward(
    user: UserWithBranch & { id: string },
    customerRewardId: string,
    notes?: string,
  ) {
    const cr = await this.prisma.customer_rewards.findFirst({
      where: applyEnvironmentFilter(user, { id: customerRewardId }),
      include: { rewards: true, customers: true },
    });

    if (!cr) throw new NotFoundException('Customer reward not found');

    if (cr.status === 'claimed') {
      throw new BadRequestException('Reward already claimed');
    }
    if (cr.status === 'expired') {
      throw new BadRequestException('Reward has expired');
    }

    // Branch access check for non-super-admin
    if (!isSuperAdmin(user)) {
      if (cr.branch_id !== user.branchId) {
        throw new ForbiddenException(
          'You cannot claim rewards from another branch',
        );
      }
    }

    const updated = await this.prisma.customer_rewards.update({
      where: { id: customerRewardId },
      data: {
        status: 'claimed',
        claimed_at: new Date(),
        claimed_by_user_id: user.id,
        notes: notes?.trim() || '',
        updated_at: new Date(),
      },
      include: { rewards: true },
    });

    // Log the claim in activity_logs
    try {
      await this.prisma.activity_logs.create({
        data: {
          user_id: user.id,
          branch_id: cr.branch_id,
          action: 'REWARD_CLAIMED',
          ...environmentCreateFields(user),
          details: JSON.stringify({
            customerRewardId: cr.id,
            customerId: cr.customer_id,
            customerName: cr.customers.full_name,
            rewardName: cr.rewards.name,
            rewardType: cr.rewards.reward_type,
            rewardValue: Number(cr.rewards.reward_value),
            notes: notes?.trim() || '',
          }),
        },
      });
    } catch (err) {
      this.logger.warn('Failed to log reward claim', err);
    }

    return {
      id: updated.id,
      status: updated.status,
      claimed_at: updated.claimed_at,
      reward_name: updated.rewards.name,
      message: 'Reward claimed successfully',
    };
  }

  /* ───────────── Customer Progress (for progress indicators) ───────────── */

  async getCustomerProgress(user: UserWithBranch, customerId: string) {
    const branchFilter = isSuperAdmin(user) ? {} : buildBranchFilter(user);

    // Get customer's transaction stats
    const [transactionCount, totalAmountResult] = await Promise.all([
      this.prisma.transactions.count({
        where: {
          customer_id: customerId,
          purpose: { notIn: ['Start', 'End'] },
          ...applyEnvironmentFilter(user),
          ...branchFilter,
        },
      }),
      this.prisma.transactions.aggregate({
        where: {
          customer_id: customerId,
          purpose: { notIn: ['Start', 'End'] },
          ...applyEnvironmentFilter(user),
          ...branchFilter,
        },
        _sum: { cash_in: true },
      }),
    ]);

    const totalAmount = Number(totalAmountResult._sum.cash_in ?? 0);

    // Get all active reward rules
    const activeRewards = await this.prisma.rewards.findMany({
      where: applyEnvironmentFilter(user, { is_active: true }),
      orderBy: { required_transaction_count: 'asc' },
    });

    // Get already-earned rewards for this customer
    const earnedRewardIds = new Set(
      (
        await this.prisma.customer_rewards.findMany({
          where: applyEnvironmentFilter(user, {
            customer_id: customerId,
            ...branchFilter,
          }),
          select: { reward_id: true },
        })
      ).map((cr) => cr.reward_id),
    );

    return activeRewards.map((reward) => {
      const alreadyEarned = earnedRewardIds.has(reward.id);

      const txCountRequired = reward.required_transaction_count;
      const amountRequired = Number(reward.required_total_amount);

      // Filter by transaction_type if specified
      const txCountProgress = Math.min(transactionCount, txCountRequired);
      const amountProgress =
        amountRequired > 0
          ? Math.min(totalAmount, amountRequired)
          : amountRequired;

      const txCountMet = transactionCount >= txCountRequired;
      const amountMet = amountRequired <= 0 || totalAmount >= amountRequired;

      return {
        reward_id: reward.id,
        name: reward.name,
        description: reward.description,
        reward_type: reward.reward_type,
        reward_value: Number(reward.reward_value),
        required_transaction_count: txCountRequired,
        required_total_amount: amountRequired,
        transaction_type: reward.transaction_type,
        current_transaction_count: transactionCount,
        current_total_amount: totalAmount,
        tx_count_progress: txCountProgress,
        amount_progress: amountProgress,
        is_eligible: txCountMet && amountMet && !alreadyEarned,
        already_earned: alreadyEarned,
      };
    });
  }

  /* ─────────── Post-Transaction Hook: evaluate & grant rewards ─────────── */

  async evaluateRewardsAfterTransaction(
    user: UserWithBranch,
    customerId: string,
    branchId: string,
    transactionPurpose?: string | null,
  ) {
    if (!customerId || !branchId) return;

    try {
      const activeRewards = await this.prisma.rewards.findMany({
        where: applyEnvironmentFilter(user, { is_active: true }),
      });

      if (activeRewards.length === 0) return;

      // Get customer's aggregated stats scoped to branch
      const [txCount, totalAmountResult] = await Promise.all([
        this.prisma.transactions.count({
          where: {
            customer_id: customerId,
            branch_id: branchId,
            purpose: { notIn: ['Start', 'End'] },
            ...applyEnvironmentFilter(user),
          },
        }),
        this.prisma.transactions.aggregate({
          where: {
            customer_id: customerId,
            branch_id: branchId,
            purpose: { notIn: ['Start', 'End'] },
            ...applyEnvironmentFilter(user),
          },
          _sum: { cash_in: true },
        }),
      ]);

      const totalAmount = Number(totalAmountResult._sum.cash_in ?? 0);

      // Get already-earned reward IDs for this customer+branch
      const alreadyEarned = new Set(
        (
          await this.prisma.customer_rewards.findMany({
            where: applyEnvironmentFilter(user, {
              customer_id: customerId,
              branch_id: branchId,
            }),
            select: { reward_id: true },
          })
        ).map((cr) => cr.reward_id),
      );

      for (const reward of activeRewards) {
        if (alreadyEarned.has(reward.id)) continue;

        // Check transaction_type filter
        if (
          reward.transaction_type &&
          transactionPurpose &&
          reward.transaction_type !== transactionPurpose
        ) {
          continue;
        }

        const txCountMet = txCount >= reward.required_transaction_count;
        const amountRequired = Number(reward.required_total_amount);
        const amountMet = amountRequired <= 0 || totalAmount >= amountRequired;

        if (txCountMet && amountMet) {
          // Grant the reward (upsert to handle race conditions)
          await this.prisma.customer_rewards
            .create({
              data: {
                customer_id: customerId,
                reward_id: reward.id,
                branch_id: branchId,
                status: 'earned',
                ...environmentCreateFields(user),
              },
            })
            .catch((err) => {
              // Unique constraint violation = already earned, ignore
              if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === 'P2002'
              ) {
                return;
              }
              throw err;
            });

          this.logger.log(
            `Reward "${reward.name}" granted to customer ${customerId} in branch ${branchId}`,
          );
        }
      }
    } catch (err) {
      // Never fail the transaction because of a rewards error
      this.logger.error('Reward evaluation failed', err);
    }
  }
}
