import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsIn(['pending', 'active', 'rejected'])
  accountStatus?: 'pending' | 'active' | 'rejected';

  @IsOptional()
  @IsIn(['super_admin', 'superadmin', 'admin', 'employee', 'branch'])
  role?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string | null;
}
