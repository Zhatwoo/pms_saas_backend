import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  Req,
} from '@nestjs/common';
import { BranchesService } from '../services/branches.service';
import { CreateBranchDto } from '../dto/create-branch.dto';
import { UpdateBranchDto } from '../dto/update-branch.dto';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { assertBranchRowAccess } from '../../../common/utils/branch-scope.util';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Roles(Role.SUPER_ADMIN)
  @Post()
  create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() createBranchDto: CreateBranchDto,
  ) {
    return this.branchesService.create(createBranchDto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAll(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchesService.findAllForActor(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('overview-stats')
  getOverviewStats(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchesService.getOverviewStats(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('transfer-destinations')
  findTransferDestinations(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchesService.findTransferDestinations(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    assertBranchRowAccess(req.user, id);
    return this.branchesService.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Patch(':id')
  update(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Body() updateBranchDto: UpdateBranchDto,
  ) {
    if (req.user.role === Role.ADMIN) {
      assertBranchRowAccess(req.user, id);
    }
    return this.branchesService.update(id, updateBranchDto, req.user);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.branchesService.remove(id, req.user);
  }
}
