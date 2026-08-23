import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const PHONE_REGEX = /^\+639\d{9}$/;

export enum BranchStatus {
  ACTIVE = 'Active',
  INACTIVE = 'Inactive',
  PROCESS = 'Process',
  TERMINATED = 'Terminated',
  UNDER_MAINTENANCE = 'Under Maintenance',
}

export class CreateBranchDto {
  @IsNotEmpty()
  @IsString()
  branch_code: string;

  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  location: string;

  @IsNotEmpty()
  @IsString()
  @Matches(PHONE_REGEX, {
    message: 'contact_number must use +639XXXXXXXXX format',
  })
  contact_number: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_REGEX, {
    message: 'contactNumber must use +639XXXXXXXXX format',
  })
  contactNumber?: string;

  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus = BranchStatus.ACTIVE;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maintaining_balance?: number;
}
