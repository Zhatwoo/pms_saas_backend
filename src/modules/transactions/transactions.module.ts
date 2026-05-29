import { Module } from '@nestjs/common';
import { TransactionsController } from './controllers/transactions.controller';
import { TransactionsService } from './services/transactions.service';
import { RewardsModule } from '../rewards/rewards.module';
import { BranchFinanceModule } from '../branch-finance/branch-finance.module';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';

@Module({
  imports: [RewardsModule, BranchFinanceModule, SupabaseModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
