import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';
import { BranchFinanceController } from './branch-finance.controller';
import { BranchFinanceService } from './branch-finance.service';

@Module({
  imports: [SupabaseModule],
  controllers: [BranchFinanceController],
  providers: [BranchFinanceService],
})
export class BranchFinanceModule {}
