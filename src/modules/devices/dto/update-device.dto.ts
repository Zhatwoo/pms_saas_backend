import { IsString, IsOptional, IsIn, IsUUID } from 'class-validator';

export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  deviceName?: string;

  @IsOptional()
  @IsIn(['DESKTOP', 'LAPTOP', 'TABLET', 'MANAGER_PC', 'COUNTER_PC'])
  deviceType?: string;

  @IsOptional()
  @IsIn(['AUTHORIZED', 'BLOCKED', 'PENDING'])
  status?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}
