import {
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsIn(['super_admin', 'superadmin', 'admin', 'employee', 'branch'])
  role: 'super_admin' | 'superadmin' | 'admin' | 'employee' | 'branch';

  @ValidateIf(
    (o: CreateUserDto) =>
      o.role !== 'super_admin' && o.role !== 'superadmin',
  )
  @IsUUID()
  branchId?: string | null;
}
