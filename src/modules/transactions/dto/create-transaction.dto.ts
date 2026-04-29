import { IsOptional, IsString, IsNumber, IsObject } from 'class-validator';

export class CreateTransactionDto {
  @IsOptional()
  @IsString()
  transaction_no?: string;

  @IsOptional()
  @IsString()
  branch_id?: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsString()
  related_sale_item_id?: string;

  @IsOptional()
  @IsString()
  transaction_date?: string;

  @IsOptional()
  @IsString()
  transaction_time?: string;

  @IsOptional()
  @IsNumber()
  cash_in?: number;

  @IsOptional()
  @IsNumber()
  cash_out?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  unit_code?: string;

  @IsOptional()
  @IsObject()
  details?: any;

  @IsOptional()
  @IsObject()
  layaway?: any;

  // Allow other arbitrary fields — they will be accepted by service
}
