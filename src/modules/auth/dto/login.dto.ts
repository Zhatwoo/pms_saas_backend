import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';

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
}
