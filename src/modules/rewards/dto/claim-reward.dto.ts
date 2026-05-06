import { IsString, IsOptional } from 'class-validator';

export class ClaimRewardDto {
  @IsOptional()
  @IsString()
  notes?: string;
}
