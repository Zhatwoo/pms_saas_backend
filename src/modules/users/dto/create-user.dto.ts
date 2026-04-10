import { IsEmail, IsIn, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsIn(['admin', 'employee'])
  role: 'admin' | 'employee';

  @IsUUID()
  branchId: string;
}
