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
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { ConfirmFundRequestDto } from '../dto/confirm-fund-request.dto';
import { CreateFundRequestDto } from '../dto/create-fund-request.dto';
import { ListFundRequestsDto } from '../dto/list-fund-requests.dto';
import { ReviewFundRequestDto } from '../dto/review-fund-request.dto';
import { TransferFundRequestDto } from '../dto/transfer-fund-request.dto';
import { FundRequestsService } from '../services/fund-requests.service';

@Controller('fund-requests')
export class FundRequestsController {
  constructor(private readonly fundRequestsService: FundRequestsService) {}

  @Roles(Role.ADMIN)
  @Post()
  create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() createFundRequestDto: CreateFundRequestDto,
  ) {
    return this.fundRequestsService.create(req.user, createFundRequestDto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get()
  findAll(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query() query: ListFundRequestsDto,
  ) {
    return this.fundRequestsService.findAll(req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.fundRequestsService.findOne(req.user, id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id/review')
  review(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() reviewDto: ReviewFundRequestDto,
  ) {
    return this.fundRequestsService.review(req.user, id, reviewDto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id/transfer')
  transfer(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() transferDto: TransferFundRequestDto,
  ) {
    return this.fundRequestsService.transfer(req.user, id, transferDto);
  }

  @Roles(Role.ADMIN)
  @Patch(':id/cancel')
  cancel(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.fundRequestsService.cancel(req.user, id);
  }

  @Roles(Role.ADMIN)
  @Patch(':id/confirm')
  confirm(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() confirmDto: ConfirmFundRequestDto,
  ) {
    return this.fundRequestsService.confirm(req.user, id, confirmDto);
  }
}
