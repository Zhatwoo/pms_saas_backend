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
    const supabaseJwtSecret = configService.get<string>('supabase.jwtSecret');
    const jwksSecretProvider = passportJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    });
    
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // audience: 'authenticated',
      // issuer: `${supabaseUrl}/auth/v1`,
      algorithms: ['RS256', 'ES256', 'HS256'],
      // Supabase can issue symmetric (HS256) or asymmetric (RS/ES) access tokens.
      // Use the local secret for HS256 and JWKS for RS/ES keys.
      secretOrKeyProvider: (
        _req: unknown,
        rawJwtToken: string,
        done: (err: Error | null, secret?: string | Buffer) => void,
      ) => {
        try {
          const headerSegment = rawJwtToken?.split('.')?.[0];

          if (!headerSegment) {
            return done(new Error('Invalid JWT format'));
          }

          const decodedHeader = JSON.parse(
            Buffer.from(headerSegment, 'base64url').toString('utf8'),
          ) as { alg?: string };

          if (decodedHeader.alg === 'HS256') {
            if (!supabaseJwtSecret) {
              return done(new Error('Missing SUPABASE_JWT_SECRET'));
            }
            return done(null, supabaseJwtSecret);
          }

          return jwksSecretProvider(_req as any, rawJwtToken, done as any);
        } catch (error) {
          return done(error as Error);
        }
      },
    });

  }

  async validate(payload: JwtPayload) {
    if (!payload || !payload.sub) {
      console.error('[JWT Strategy] Invalid payload:', payload);
      throw new UnauthorizedException('Invalid token payload');
    }

    console.log(`[JWT Strategy] Validating user: ${payload.email} (${payload.sub})`);

    const user = await this.supabaseService.getUserByAuthId(payload.sub);

    if (!user) {
      console.warn(`[JWT Strategy] User NOT FOUND for auth ID: ${payload.sub}`);
      throw new UnauthorizedException('User account not found in database');
    }

    return user;
  }
}

