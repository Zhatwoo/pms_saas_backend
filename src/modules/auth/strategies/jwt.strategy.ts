import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import type { Request } from 'express';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { parseCookieHeader } from '../../../common/utils/cookie.util';

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
      jwtFromRequest: ExtractJwt.fromExtractors<Request>([
        (req: Request) => {
          const cookies = parseCookieHeader(req?.headers?.cookie);
          return cookies.pms_access_token || null;
        },
        (req: Request) =>
          process.env.ALLOW_BEARER_AUTH === 'true'
            ? ExtractJwt.fromAuthHeaderAsBearerToken()(req)
            : null,
      ]),
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

          return jwksSecretProvider(_req, rawJwtToken, done);
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

    try {
      const user = await this.supabaseService.assertSessionUserByAuthId(
        payload.sub,
      );
      return user;
    } catch (err) {
      console.error(
        `[JWT Strategy] Validation failed for ${payload.sub}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  }
}
