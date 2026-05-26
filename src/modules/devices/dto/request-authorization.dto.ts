import { IsString, IsOptional, IsIn, IsEmail } from 'class-validator';

export class RequestAuthorizationDto {
  @IsString()
  deviceFingerprint: string;

  @IsOptional()
  @IsString()
  deviceName?: string;

  @IsOptional()
  @IsIn(['DESKTOP', 'LAPTOP', 'TABLET', 'MANAGER_PC', 'COUNTER_PC'])
  deviceType?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  /** Employee email — used to link the request when called from the unauthenticated login screen. */
  @IsOptional()
  @IsEmail()
  email?: string;
}
