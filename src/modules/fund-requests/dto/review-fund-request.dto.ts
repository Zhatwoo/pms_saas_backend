import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export enum FundRequestReviewDecision {
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export class ReviewFundRequestDto {
  @IsEnum(FundRequestReviewDecision)
  decision: FundRequestReviewDecision;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  approvedAmount?: number;

  @IsOptional()
  @IsString()
  reviewNotes?: string;
}
