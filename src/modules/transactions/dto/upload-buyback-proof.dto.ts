import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UploadBuybackProofDto {
  @IsString()
  @IsNotEmpty()
  transactionNo!: string;

  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  fileData!: string;

  @IsOptional()
  @IsString()
  branchId?: string;
}
