import { Controller, Post, Get, Body, Req } from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { BranchesService } from '../../branches/services/branches.service';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { Public } from '../../../common/decorators';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly branchesService: BranchesService,
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
}
