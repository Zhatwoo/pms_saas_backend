import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class ShopSettingsService {
  constructor(
    private supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async getSetting(key: string) {
    const data = await this.prisma.shop_settings.findUnique({
      where: { setting_key: key },
      select: { setting_value: true },
    });

    if (!data) {
      throw new NotFoundException(`Setting ${key} not found`);
    }

    return data.setting_value;
  }

  async setSetting(key: string, value: any) {
    try {
      return await this.prisma.shop_settings.upsert({
        where: { setting_key: key },
        create: {
          setting_key: key,
          setting_value: value,
          updated_at: new Date(),
        },
        update: {
          setting_value: value,
          updated_at: new Date(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(message);
    }
  }
}
