import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { InventoryService } from '../services/inventory.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ─── PAWNED ITEMS ──────────────────────────────────────────
  @Get('pawned')
  findAllPawned(
    @Query('branch') branch?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.findAllPawned({
      branch, category, status, search,
      page: parseInt(page || '1'),
      limit: parseInt(limit || '10'),
    });
  }

  @Roles(Role.ADMIN)
  @Post('pawned')
  createPawned(@Body() dto: any) {
    return this.inventoryService.createPawned(dto);
  }

  @Get('pawned/:id')
  findOnePawned(@Param('id') id: string) {
    return this.inventoryService.findOnePawned(id);
  }

  @Roles(Role.ADMIN)
  @Put('pawned/:id')
  updatePawned(@Param('id') id: string, @Body() dto: any) {
    return this.inventoryService.updatePawned(id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete('pawned/:id')
  deletePawned(@Param('id') id: string) {
    return this.inventoryService.deletePawned(id);
  }

  // Renewal tracking
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post('pawned/:id/renew')
  addRenewal(@Param('id') id: string, @Body() dto: { renewal_date: string; amount_paid: number }) {
    return this.inventoryService.addRenewal(id, dto);
  }

  // Remarks
  @Post('pawned/:id/remarks')
  addRemark(@Param('id') id: string, @Body() dto: { remark: string }) {
    return this.inventoryService.addRemark(id, dto.remark);
  }

  // Mark as Expired → auto-transfer to Items For Sale
  @Roles(Role.ADMIN)
  @Post('pawned/:id/expire')
  expireItem(@Param('id') id: string) {
    return this.inventoryService.expireAndTransfer(id);
  }

  // QR Scan tally endpoint
  @Post('pawned/qr-tally')
  qrTally(@Body() dto: { branch_id: number; scanned_item_ids: string[] }) {
    return this.inventoryService.qrTally(dto.branch_id, dto.scanned_item_ids);
  }

  // ─── ITEMS FOR SALE ────────────────────────────────────────
  @Get('for-sale')
  findAllForSale(
    @Query('branch') branch?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('viewMode') viewMode?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.findAllForSale({
      branch, category, status, search, viewMode,
      page: parseInt(page || '1'),
      limit: parseInt(limit || '10'),
    });
  }

  @Roles(Role.ADMIN)
  @Post('for-sale/:id/mark-sold')
  markSold(@Param('id') id: string, @Body() dto: { sold_price: number; branch_id: number }) {
    return this.inventoryService.markSoldAndAddToBalance(id, dto.sold_price, dto.branch_id);
  }

  @Get('for-sale/:id')
  findOneForSale(@Param('id') id: string) {
    return this.inventoryService.findOneForSale(id);
  }

  @Roles(Role.ADMIN)
  @Put('for-sale/:id')
  updateForSale(@Param('id') id: string, @Body() dto: any) {
    return this.inventoryService.updateForSale(id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete('for-sale/:id')
  deleteForSale(@Param('id') id: string) {
    return this.inventoryService.deleteForSale(id);
  }
}
