import { IsString, IsOptional, IsNumber, IsBoolean, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateRewardDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  reward_type?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  reward_value?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  required_transaction_count?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  required_total_amount?: number;

  @IsOptional()
  @IsString()
  transaction_type?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
