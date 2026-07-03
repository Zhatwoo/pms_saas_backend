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
    // Only treat plain objects specially. Arrays (e.g. interest_rates) must be
    // preserved as-is — spreading an array into an object corrupts it into
    // { "0": ..., "1": ... }, which then fails Array.isArray checks on read.
    const isPlainObject =
      value !== null && typeof value === 'object' && !Array.isArray(value);
    const broadcastToAllEnvironments = isPlainObject
      ? Boolean(value.broadcastToAllEnvironments)
      : false;
    const payload = isPlainObject
      ? { ...value, broadcastToAllEnvironments: undefined }
      : value;

    if (broadcastToAllEnvironments && key === 'moa_template') {
      return this.settingsService.broadcastSetting(key, payload, req.user);
    }

    return this.settingsService.setSetting(key, payload, req.user);
  }
}
