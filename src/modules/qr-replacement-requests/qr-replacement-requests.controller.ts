import { Controller, Post, Put, Get, Body, Param, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { QRReplacementRequestsService } from './services/qr-replacement-requests.service';
import { CreateQRReplacementRequestDto, ApproveQRReplacementRequestDto, RejectQRReplacementRequestDto } from './dto/qr-replacement-request.dto';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';

@Controller('api/qr-replacement-requests')
@UseGuards(JwtAuthGuard)
export class QRReplacementRequestsController {
  constructor(private readonly qrReplacementService: QRReplacementRequestsService) {}

  @Post()
  async create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: CreateQRReplacementRequestDto,
  ) {
    return this.qrReplacementService.createRequest(req.user.id, req.user.branchId!, dto.pawnedItemId, dto);
  }

  @Get('branch/:branchId')
  async getByBranch(@Param('branchId') branchId: string) {
    return this.qrReplacementService.getRequestsByBranch(branchId);
  }

  @Get('branch/:branchId/status/:status')
  async getByStatus(@Param('branchId') branchId: string, @Param('status') status: string) {
    return this.qrReplacementService.getRequestsByStatus(branchId, status);
  }

  @Get(':requestId')
  async getById(@Param('requestId') requestId: string) {
    return this.qrReplacementService.getRequestById(requestId);
  }

  @Put(':requestId/approve')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async approve(
    @Param('requestId') requestId: string,
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: ApproveQRReplacementRequestDto,
  ) {
    return this.qrReplacementService.approveRequest(requestId, req.user.id, dto);
  }

  @Put(':requestId/reject')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async reject(
    @Param('requestId') requestId: string,
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: RejectQRReplacementRequestDto,
  ) {
    return this.qrReplacementService.rejectRequest(requestId, req.user.id, dto);
  }
}
