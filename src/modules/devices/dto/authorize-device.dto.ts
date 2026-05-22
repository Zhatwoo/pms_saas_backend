import { IsString, IsUUID, IsOptional, IsIn } from 'class-validator';

export class AuthorizeDeviceDto {
  @IsUUID()
  employeeId: string;

  @IsString()
  deviceFingerprint: string;

  @IsString()
  deviceName: string;

  @IsOptional()
  @IsIn(['DESKTOP', 'LAPTOP', 'TABLET', 'MANAGER_PC', 'COUNTER_PC'])
  deviceType?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;
}
