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

    const profile = await this.supabaseService.getProfile(data.user.id);

    if (!profile) {
      throw new UnauthorizedException('User profile not found');
    }

    return {
      access_token: data.session.access_token,
      expires_in: data.session.expires_in,
      user: {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        role: profile.role,
        branchId: profile.branch_id,
        avatarUrl: profile.avatar_url,
      },
    };
  }

  async getProfile(userId: string) {
    const profile = await this.supabaseService.getProfile(userId);

    if (!profile) {
      throw new UnauthorizedException('Profile not found');
    }

    return {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role,
      branchId: profile.branch_id,
      avatarUrl: profile.avatar_url,
    };
  }
}
