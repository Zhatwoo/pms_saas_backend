import { IsIn, IsOptional, IsString } from 'class-validator';

export class UploadFundTransferProofDto {
  @IsString()
  requestNo!: string;

  @IsIn(['source', 'destination', 'release'])
  stage!: 'source' | 'destination' | 'release';

  @IsString()
  fileData!: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  branchId?: string;
}