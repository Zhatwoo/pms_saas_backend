import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsEnum,
  Matches,
  IsNumber,
  Min,
} from 'class-validator';
import { BranchStatus, PHONE_REGEX } from './create-branch.dto';

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_REGEX, {
    message: 'contact_number must use +639XXXXXXXXX format',
  })
  contact_number?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_REGEX, {
    message: 'contactNumber must use +639XXXXXXXXX format',
  })
  contactNumber?: string;

  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maintaining_balance?: number;
}
