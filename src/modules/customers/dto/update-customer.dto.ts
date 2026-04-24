import { IsOptional, IsString, IsEmail, Matches } from 'class-validator';

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  full_name?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  barangay?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @Matches(/^\+?[0-9]{7,15}$/)
  contact_number?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  id_presented?: string;

  @IsOptional()
  @IsString()
  requestingEmployeeId?: string;

  @IsOptional()
  @IsString()
  logId?: string;
}
