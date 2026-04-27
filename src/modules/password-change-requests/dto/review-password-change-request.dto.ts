import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum PasswordChangeRequestDecision {
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export class ReviewPasswordChangeRequestDto {
  @IsEnum(PasswordChangeRequestDecision)
  decision: PasswordChangeRequestDecision;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
