import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ShopSettingsService } from '../services/shop-settings.service';
import { JwtAuthGuard, RolesGuard } from '../../../common/guards';
import { Roles } from '../../../common/decorators/roles.decorator';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShopSettingsController {
  constructor(private readonly settingsService: ShopSettingsService) {}

  @Get(':key')
  getSetting(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('key') key: string,
  ) {
    return this.settingsService.getSetting(key, req.user);
  }

  @Post(':key')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  setSetting(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('key') key: string,
    @Body() value: any,
  ) {
    return this.settingsService.setSetting(key, value, req.user);
  }
}
