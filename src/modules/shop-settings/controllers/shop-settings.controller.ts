import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ShopSettingsService } from '../services/shop-settings.service';
import { JwtAuthGuard, RolesGuard } from '../../../common/guards';
import { Roles } from '../../../common/decorators/roles.decorator';
import { Role } from '../../../common/enums';

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShopSettingsController {
  constructor(private readonly settingsService: ShopSettingsService) {}

  @Get(':key')
  getSetting(@Param('key') key: string) {
    return this.settingsService.getSetting(key);
  }

  @Post(':key')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  setSetting(@Param('key') key: string, @Body() value: any) {
    return this.settingsService.setSetting(key, value);
  }
}
