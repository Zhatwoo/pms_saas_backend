import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Roles, Public } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { DevicesService } from '../services/devices.service';
import { AuthorizeDeviceDto } from '../dto/authorize-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { RequestAuthorizationDto } from '../dto/request-authorization.dto';

function getClientIp(req: any): string {
  return (
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    ''
  );
}

@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  /** Super admin / admin — list all devices */
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get()
  findAll(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.devicesService.findAll(req.user);
  }

  /** Login logs — super admin or admin */
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get('logs')
  findLogs(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ) {
    return this.devicesService.findLogs(req.user, limit);
  }

  /** Public — called from the login screen before the employee is authenticated.
   *  Employee email in the body is used to look up their DB id. */
  @Public()
  @Post('request-authorization')
  requestAuthorization(@Req() req: any, @Body() dto: RequestAuthorizationDto) {
    return this.devicesService.requestAuthorization(
      null,
      dto,
      getClientIp(req),
    );
  }

  /** Super admin authorizes a device */
  @Roles(Role.SUPER_ADMIN)
  @Post('authorize')
  authorize(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: AuthorizeDeviceDto,
  ) {
    return this.devicesService.authorize(req.user, dto);
  }

  /** View single device */
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.devicesService.findOne(req.user, id);
  }

  /** Update device name / type / branch / status */
  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  update(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(req.user, id, dto);
  }

  /** Block a stolen device immediately */
  @Roles(Role.SUPER_ADMIN)
  @Patch(':id/block')
  block(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.devicesService.block(req.user, id);
  }

  /** Remove device permanently */
  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.devicesService.remove(req.user, id);
  }
}
