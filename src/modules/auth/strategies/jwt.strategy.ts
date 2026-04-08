import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

interface JwtPayload {
  sub: string;
  email: string;
  aud: string;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private supabaseService: SupabaseService,
  ) {
    const supabaseUrl = configService.get<string>('supabase.url');
    
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // audience: 'authenticated',
      // issuer: `${supabaseUrl}/auth/v1`,
      algorithms: ['RS256', 'ES256', 'HS256'],
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      }),
    });

  }

  async validate(payload: JwtPayload) {
    if (!payload || !payload.sub) {
      console.error('[JWT Strategy] Invalid payload:', payload);
      throw new UnauthorizedException('Invalid token payload');
    }

    console.log(`[JWT Strategy] Validating user: ${payload.email} (${payload.sub})`);

    const profile = await this.supabaseService.getProfile(payload.sub);

    if (!profile) {
      console.warn(`[JWT Strategy] Profile NOT FOUND for ID: ${payload.sub}`);
      throw new UnauthorizedException('Profile not found in database');
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

