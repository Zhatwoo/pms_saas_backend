import { Controller, Post, Body, Req, Get, Query, Param, Put } from '@nestjs/common';
import { CustomersService } from '../services/customers.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { UpdateCustomerDto } from '../dto/update-customer.dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() createCustomerDto: CreateCustomerDto,
  ) {
    return this.customersService.create(req.user, createCustomerDto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAll(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branchId') branchId?: string,
  ) {
    return this.customersService.findAll(req.user, branchId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Post('merge-duplicates')
  mergeDuplicateCustomers(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() dto: { branchId?: string },
  ) {
    return this.customersService.mergeDuplicateCustomers(req.user, dto?.branchId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.customersService.findOne(req.user, id);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Put(':id')
  update(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() updateDto: any,
  ) {
    return this.customersService.update(req.user, id, updateDto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id/activity-logs')
  findCustomerActivityLogs(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.customersService.findCustomerActivityLogs(req.user, id);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post(':id/activity-logs')
  addCustomerNote(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { title?: string; note?: string },
  ) {
    return this.customersService.addCustomerNote(
      req.user,
      id,
      dto?.title,
      dto?.note,
    );
  }

  @Roles(Role.EMPLOYEE)
  @Post(':id/request-edit')
  requestEdit(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() dto: { notes: string },
  ) {
    return this.customersService.requestEdit(req.user, id, dto.notes);
  }
}

