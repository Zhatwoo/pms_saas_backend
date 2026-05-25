import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  Req,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUTH_STRICT_THROTTLE } from '../../../config/throttle-auth.constants';
import { UsersService } from '../services/users.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { TransferUserBranchDto } from '../dto/transfer-user-branch.dto';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

function getAuditChangedFields(dto: UpdateUserDto) {
  return Object.keys(dto).filter((key) => key !== 'currentPassword');
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles(Role.SUPER_ADMIN)
  /** Super-admin user creation — high-value target for automated abuse when credentials leak. */
  @Throttle(AUTH_STRICT_THROTTLE)
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get()
  findAll(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branchId') branchId?: string,
  ) {
    if (req.user.role === Role.SUPER_ADMIN) {
      if (branchId?.trim()) {
        return this.usersService.findAll({
          branchId: branchId.trim(),
          scopedToBranch: true,
        });
      }

      return this.usersService.findAll();
    }
    if (!req.user.branchId) {
      return [];
    }
    return this.usersService.findAll({
      branchId: req.user.branchId,
      scopedToBranch: true,
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

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Patch(':id')
  async update(
    @Req()
    req: {
      user: AuthenticatedUserProfile;
      auditLogContext?: Record<string, unknown>;
    },
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const updated = await this.usersService.update(id, updateUserDto, req.user);
    req.auditLogContext = {
      targetUserId: updated.id,
      targetUserName: updated.fullName ?? updated.email,
      targetBranchName: updated.branchName ?? null,
      changedFields: getAuditChangedFields(updateUserDto),
    };
    return updated;
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id/transfer-branch')
  async transferBranch(
    @Req()
    req: {
      user: AuthenticatedUserProfile;
      auditLogContext?: Record<string, unknown>;
    },
    @Param('id') id: string,
    @Body() transferDto: TransferUserBranchDto,
  ) {
    const updated = await this.usersService.transferBranch(
      id,
      transferDto.branchId,
    );
    req.auditLogContext = {
      targetUserId: updated.id,
      targetUserName: updated.fullName ?? updated.email,
      targetBranchName: updated.branchName ?? null,
      changedFields: ['branchId'],
    };
    return updated;
  }

  // NextJS Turbopack workaround using POST instead of PATCH/PUT
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Post(':id/update')
  async updatePost(
    @Req()
    req: {
      user: AuthenticatedUserProfile;
      auditLogContext?: Record<string, unknown>;
    },
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const updated = await this.usersService.update(id, updateUserDto, req.user);
    req.auditLogContext = {
      targetUserId: updated.id,
      targetUserName: updated.fullName ?? updated.email,
      targetBranchName: updated.branchName ?? null,
      changedFields: getAuditChangedFields(updateUserDto),
    };
    return updated;
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  async remove(
    @Req()
    req: {
      user: AuthenticatedUserProfile;
      auditLogContext?: Record<string, unknown>;
    },
    @Param('id') id: string,
  ) {
    const result = await this.usersService.remove(id);
    req.auditLogContext = {
      targetUserId: result.targetUserId,
      targetUserName: result.targetUserName,
    };
    return { deleted: true };
  }
}
