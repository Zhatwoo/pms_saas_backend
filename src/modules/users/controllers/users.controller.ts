import { Controller, Get, Post, Body, Param, Delete } from '@nestjs/common';
import { UsersService } from '../services/users.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import { CreateUserDto } from '../dto/create-user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles(Role.SUPER_ADMIN)
  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    console.log('[UsersController.create] Received payload:', createUserDto);
    console.log('[UsersController.create] Payload types:', {
      fullName: typeof createUserDto.fullName,
      email: typeof createUserDto.email,
      password: typeof createUserDto.password,
      role: typeof createUserDto.role,
      branchId: typeof createUserDto.branchId,
    });
    console.log('[UsersController.create] Branch ID value:', createUserDto.branchId, {
      isEmpty: !createUserDto.branchId,
      length: createUserDto.branchId?.length,
    });
    
    try {
      const result = await this.usersService.create(createUserDto);
      console.log('[UsersController.create] Success, result:', result);
      return result;
    } catch (error) {
      console.error('[UsersController.create] Error:', error);
      throw error;
    }
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}
