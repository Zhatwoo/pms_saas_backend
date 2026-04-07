import { Module } from '@nestjs/common';
import { BranchesController } from './controllers/branches.controller';
import { BranchesService } from './services/branches.service';

@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
