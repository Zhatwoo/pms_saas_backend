import { Module } from '@nestjs/common';
import { QRReplacementRequestsController } from './qr-replacement-requests.controller';
import { QRReplacementRequestsService } from './services/qr-replacement-requests.service';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [QRReplacementRequestsController],
  providers: [QRReplacementRequestsService],
  exports: [QRReplacementRequestsService],
})
export class QRReplacementRequestsModule {}
