import { IsOptional, IsString, IsEnum } from 'class-validator';
import { BranchStatus } from './create-branch.dto';

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus;
}
