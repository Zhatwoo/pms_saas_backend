import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsIn(['pending', 'active', 'rejected'])
  accountStatus?: 'pending' | 'active' | 'rejected';

  @IsOptional()
  @IsIn(['super_admin', 'superadmin', 'admin', 'employee', 'branch'])
  role?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsIn([
    'sound1.mp3',
    'sound2.mp3',
    'sound3.mp3',
    'sound4.mp3',
    'sound5.mp3',
    'sound6.mp3',
    'sound7.mp3',
    'sound8.mp3',
  ])
  notificationSound?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  currentPassword?: string;
}
