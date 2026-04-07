import { Controller, Get, Post, Body, Param, Patch, Delete } from '@nestjs/common';
import { BranchesService } from '../services/branches.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Roles(Role.SUPERADMIN)
  @Post()
  create(@Body() createBranchDto: any) {
    return this.branchesService.create(createBranchDto);
  }

  @Roles(Role.SUPERADMIN, Role.ADMIN)
  @Get()
  findAll() {
    return this.branchesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.branchesService.findOne(id);
  }

  @Roles(Role.SUPERADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateBranchDto: any) {
    return this.branchesService.update(id, updateBranchDto);
  }

  @Roles(Role.SUPERADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.branchesService.remove(id);
  }
}
