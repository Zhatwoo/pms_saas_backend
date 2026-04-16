import { Module } from '@nestjs/common';
import { ShopSettingsService } from './services/shop-settings.service';
import { ShopSettingsController } from './controllers/shop-settings.controller';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [ShopSettingsController],
  providers: [ShopSettingsService],
  exports: [ShopSettingsService],
})
export class ShopSettingsModule {}
