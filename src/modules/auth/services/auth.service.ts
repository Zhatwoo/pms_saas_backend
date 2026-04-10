import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { LoginDto } from '../dto/login.dto';

@Injectable()
export class AuthService {
  constructor(private supabaseService: SupabaseService) {}

  async login(loginDto: LoginDto) {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginDto.email,
      password: loginDto.password,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    const user = await this.supabaseService.getUserByAuthId(data.user.id);

    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    return {
      access_token: data.session.access_token,
      expires_in: data.session.expires_in,
      user: {
        id: user.id,
        authId: user.authId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        branchId: user.branchId,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.supabaseService.getUserById(userId);

    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    return {
      id: user.id,
      authId: user.authId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      branchId: user.branchId,
      avatarUrl: user.avatarUrl,
    };
  }
}
