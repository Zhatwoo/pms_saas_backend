import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { BranchesService } from '../../branches/services/branches.service';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { VerifyPasswordDto } from '../dto/verify-password.dto';
import { UpdateUserDto } from '../../users/dto/update-user.dto';
import { UsersService } from '../../users/services/users.service';
import { Public } from '../../../common/decorators';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly branchesService: BranchesService,
    private readonly usersService: UsersService,
  ) {}

  /** Public branch list for signup (avoids /branches/:id catching "public"). */
  @Public()
  @Get('signup/branches')
  signupBranches() {
    return this.branchesService.findActiveSummaries();
  }

  @Public()
  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('me')
  getMe(@Req() req: any) {
    return this.authService.getProfile(req.user.id);
  }

  @Post('verify-password')
  async verify(@Req() req: any, @Body() dto: VerifyPasswordDto) {
    const isValid = await this.authService.verifyPassword(
      req.user.authId,
      req.user.email,
      dto.password,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid password');
    }

    return { success: true };
  }

  @Post('profile') // Turbopack workaround: using POST for updates
  async updateProfilePost(@Req() req: any, @Body() dto: UpdateUserDto) {
    return this.updateProfile(req, dto);
  }

  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() dto: UpdateUserDto) {
    const sanitized: UpdateUserDto = {};
    if (dto.fullName !== undefined) sanitized.fullName = dto.fullName;
    if (dto.avatarUrl !== undefined) sanitized.avatarUrl = dto.avatarUrl;
    
    return this.usersService.update(req.user.id, sanitized);
  }
}
