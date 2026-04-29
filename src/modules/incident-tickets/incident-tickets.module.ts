import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';
import { IncidentTicketsController } from './incident-tickets.controller';
import { IncidentTicketsService } from './incident-tickets.service';

@Module({
  imports: [SupabaseModule],
  controllers: [IncidentTicketsController],
  providers: [IncidentTicketsService],
  exports: [IncidentTicketsService],
})
export class IncidentTicketsModule {}
