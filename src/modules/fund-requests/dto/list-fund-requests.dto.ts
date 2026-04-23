import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum FundRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  PENDING_SOURCE_CONFIRMATION = 'pending_source_confirmation',
  PENDING_CONFIRMATION = 'pending_confirmation',
  REJECTED = 'rejected',
  TRANSFERRED = 'transferred',
  CANCELLED = 'cancelled',
}

export class ListFundRequestsDto {
  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsEnum(FundRequestStatus)
  status?: FundRequestStatus;

  @IsOptional()
  @IsString()
  search?: string;
}
