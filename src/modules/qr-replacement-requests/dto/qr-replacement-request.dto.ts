import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export enum QRReplacementReason {
  DAMAGED = 'damaged',
  LOST = 'lost',
  TORN = 'torn',
}

export class CreateQRReplacementRequestDto {
  @IsUUID()
  pawnedItemId!: string;

  @IsEnum(QRReplacementReason)
  reason!: QRReplacementReason;

  @IsOptional()
  @IsString()
  description?: string;
}

export class ApproveQRReplacementRequestDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RejectQRReplacementRequestDto {
  @IsString()
  rejectionReason!: string;
}
