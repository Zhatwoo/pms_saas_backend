import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class ShopSettingsService {
  constructor(private supabase: SupabaseService) {}

  async getSetting(key: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('shop_settings')
      .select('setting_value')
      .eq('setting_key', key)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new NotFoundException(`Setting ${key} not found`);
    }

    return data.setting_value;
  }

  async setSetting(key: string, value: any) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('shop_settings')
      .upsert(
        { setting_key: key, setting_value: value, updated_at: new Date() },
        { onConflict: 'setting_key' },
      )
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }
}
