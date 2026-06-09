import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import { IncidentTicketsService } from './incident-tickets.service';
import { RequiresOpeningChecklist } from '../../common/decorators';

@RequiresOpeningChecklist()
@Controller('incident-tickets')
export class IncidentTicketsController {
  constructor(
    private readonly incidentTicketsService: IncidentTicketsService,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAll(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.incidentTicketsService.findAll(req.user, branch);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(@Req() req: { user: AuthenticatedUserProfile }, @Body() body: any) {
    return this.incidentTicketsService.create(req.user, body);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Patch(':id')
  update(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.incidentTicketsService.update(req.user, id, body);
  }
}
