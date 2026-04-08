import { Module } from '@nestjs/common';
import { BranchesController } from './controllers/branches.controller';
import { BranchesService } from './services/branches.service';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}

