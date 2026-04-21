import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Patch,
} from '@nestjs/common';
import { InventoryService } from '../services/inventory.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('pawned')
  findAllPawned(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.findAllPawned(req.user, {
      branch,
      category,
      status,
      search,
      page: parseInt(page || '1'),
      limit: parseInt(limit || '10'),
    });
  }

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned')
  createPawned(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: any,
  ) {
    return this.inventoryService.createPawned(req.user, dto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('pawned/:id')
  findOnePawned(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.inventoryService.findOnePawned(req.user, id);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('item/:itemId')
  findByItemId(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('itemId') itemId: string,
  ) {
    return this.inventoryService.findByItemId(req.user, itemId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Put('pawned/:id')
  @Patch('pawned/:id')
  updatePawned(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.inventoryService.updatePawned(req.user, id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete('pawned/:id')
  deletePawned(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.inventoryService.deletePawned(req.user, id);
  }

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned/:id/renew')
  addRenewal(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { renewal_date: string; amount_paid: number },
  ) {
    return this.inventoryService.addRenewal(req.user, id, dto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned/:id/remarks')
  addRemark(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { remark: string },
  ) {
    return this.inventoryService.addRemark(req.user, id, dto.remark);
  }

  @Roles(Role.ADMIN)
  @Post('pawned/:id/expire')
  expireItem(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.inventoryService.expireAndTransfer(req.user, id);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned/:id/expire-request')
  requestExpireApproval(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { message?: string },
  ) {
    return this.inventoryService.requestExpireApproval(
      req.user,
      id,
      dto?.message,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned/:id/request-expire')
  requestExpireApprovalLegacyPath(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { message?: string },
  ) {
    return this.inventoryService.requestExpireApproval(
      req.user,
      id,
      dto?.message,
    );
  }

  @Roles(Role.SUPER_ADMIN)
  @Post('pawned/:id/expire-request/:requestId/review')
  reviewExpireApprovalPost(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: { decision?: 'approve' | 'reject'; note?: string },
  ) {
    return this.inventoryService.reviewExpireApproval(
      req.user,
      id,
      requestId,
      dto?.decision,
      dto?.note,
    );
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch('pawned/:id/expire-request/:requestId/review')
  reviewExpireApprovalPatch(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: { decision?: 'approve' | 'reject'; note?: string },
  ) {
    return this.inventoryService.reviewExpireApproval(
      req.user,
      id,
      requestId,
      dto?.decision,
      dto?.note,
    );
  }

  @Roles(Role.SUPER_ADMIN)
  @Post('pawned/:id/request-expire/:requestId/review')
  reviewExpireApprovalLegacyPathPost(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: { decision?: 'approve' | 'reject'; note?: string },
  ) {
    return this.inventoryService.reviewExpireApproval(
      req.user,
      id,
      requestId,
      dto?.decision,
      dto?.note,
    );
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch('pawned/:id/request-expire/:requestId/review')
  reviewExpireApprovalLegacyPathPatch(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: { decision?: 'approve' | 'reject'; note?: string },
  ) {
    return this.inventoryService.reviewExpireApproval(
      req.user,
      id,
      requestId,
      dto?.decision,
      dto?.note,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned/qr-tally')
  qrTally(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: { branch_id: string | number; scanned_item_ids: string[] },
  ) {
    return this.inventoryService.qrTally(
      req.user,
      dto.branch_id,
      dto.scanned_item_ids,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('for-sale')
  findAllForSale(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('viewMode') viewMode?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.findAllForSale(req.user, {
      branch,
      category,
      status,
      search,
      viewMode,
      page: parseInt(page || '1'),
      limit: parseInt(limit || '10'),
    });
  }

  @Roles(Role.ADMIN)
  @Post('for-sale/:id/mark-sold')
  markSold(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { sold_price: number; branch_id: number | string },
  ) {
    return this.inventoryService.markSoldAndAddToBalance(
      req.user,
      id,
      dto.sold_price,
      dto.branch_id,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('for-sale/:id')
  findOneForSale(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.inventoryService.findOneForSale(req.user, id);
  }

  @Roles(Role.ADMIN)
  @Put('for-sale/:id')
  updateForSale(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.inventoryService.updateForSale(req.user, id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete('for-sale/:id')
  deleteForSale(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.inventoryService.deleteForSale(req.user, id);
  }
}
