import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  /** Browser/device fingerprint from FingerprintJS (visitorId). */
  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  /** Persist the "was logged in" cookie across browser restarts. */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
