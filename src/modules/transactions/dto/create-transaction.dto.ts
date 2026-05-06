import { Type } from 'class-transformer';
import {
  Allow,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateTransactionDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  related_pawned_item_id?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsString()
  transaction_no?: string;

  @IsOptional()
  @IsString()
  transaction_date?: string;

  @IsOptional()
  @IsString()
  transaction_time?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cash_in?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cash_out?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  return_amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  storage_fee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pawn_amount?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  unit_code?: string;

  @IsOptional()
  @IsString()
  details?: string;

  @IsOptional()
  @IsString()
  profile_photo?: string;

  @IsOptional()
  @IsString()
  id_photo?: string;

  @IsOptional()
  @IsString()
  id_back_photo?: string;

  @IsOptional()
  @Allow()
  layaway?: unknown;
}
