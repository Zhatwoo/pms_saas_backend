import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

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
}
