import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { PawnTicketsService } from '../services/pawn-tickets.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { CreatePawnTicketDto } from '../dto/create-pawn-ticket.dto';

@Controller('pawn-tickets')
export class PawnTicketsController {
  constructor(private readonly pawnTicketsService: PawnTicketsService) {}

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() createPawnTicketDto: CreatePawnTicketDto,
  ) {
    return this.pawnTicketsService.create(req.user, createPawnTicketDto);
  }

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Get('next-unit-code')
  getNextUnitCode(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.pawnTicketsService.generateNextUnitCode(req.user);
  }
}
