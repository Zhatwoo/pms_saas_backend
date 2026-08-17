import { IsEmail, IsString, MinLength, IsOptional, IsBoolean } from 'class-validator';

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

  /** Whether the user wants to stay logged in longer. */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
