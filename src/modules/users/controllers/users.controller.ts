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
import { UsersService } from '../services/users.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { TransferUserBranchDto } from '../dto/transfer-user-branch.dto';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles(Role.SUPER_ADMIN)
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get()
  findAll(@Req() req: { user: AuthenticatedUserProfile }) {
    if (req.user.role === Role.SUPER_ADMIN) {
      return this.usersService.findAll();
    }
    if (!req.user.branchId) {
      return [];
    }
    return this.usersService.findAll({
      branchId: req.user.branchId,
      forBranchAdmin: true,
    });
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.usersService.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id/transfer-branch')
  transferBranch(
    @Param('id') id: string,
    @Body() transferDto: TransferUserBranchDto,
  ) {
    return this.usersService.transferBranch(id, transferDto.branchId);
  }

  // NextJS Turbopack workaround using POST instead of PATCH/PUT
  @Roles(Role.SUPER_ADMIN)
  @Post(':id/update')
  updatePost(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}
