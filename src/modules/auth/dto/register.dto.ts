import { IsEmail, IsIn, IsString, IsUUID, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  @MinLength(1)
  fullName: string;

  @IsIn(['admin', 'employee'])
  role: 'admin' | 'employee';

  @IsUUID()
  branchId: string;
}
