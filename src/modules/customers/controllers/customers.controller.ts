import { Controller, Post, Body, Req, Get, Query, Param } from '@nestjs/common';
import { CustomersService } from '../services/customers.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { CreateCustomerDto } from '../dto/create-customer.dto';

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

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.customersService.findOne(req.user, id);
  }
}
