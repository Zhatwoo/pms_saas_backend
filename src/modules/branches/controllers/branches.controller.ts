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
import { Public, Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { assertBranchRowAccess } from '../../../common/utils/branch-scope.util';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  /** Static GET routes must come before @Get(':id') so "public" is not treated as an id. */
  @Public()
  @Get('public')
  findAllPublic() {
    return this.branchesService.findActiveSummaries();
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAll(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchesService.findAllForActor(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    assertBranchRowAccess(req.user, id);
    return this.branchesService.findOne(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Post()
  create(@Body() createBranchDto: CreateBranchDto) {
    return this.branchesService.create(createBranchDto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateBranchDto: UpdateBranchDto) {
    return this.branchesService.update(id, updateBranchDto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.branchesService.remove(id);
  }
}
