import { Module } from '@nestjs/common';
import { PawnTicketsController } from './controllers/pawn-tickets.controller';
import { PawnTicketsService } from './services/pawn-tickets.service';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';
import { BranchFinanceModule } from '../branch-finance/branch-finance.module';

@Module({
  imports: [SupabaseModule, BranchFinanceModule],
  controllers: [PawnTicketsController],
  providers: [PawnTicketsService],
  exports: [PawnTicketsService],
})
export class PawnTicketsModule {}
