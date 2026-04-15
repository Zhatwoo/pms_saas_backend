import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class TransferFundRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsString()
  transferReference?: string;

  @IsOptional()
  @IsString()
  transferNotes?: string;

  @IsOptional()
  @IsUUID()
  receiverUserId?: string;

  @IsOptional()
  @IsIn(['admin', 'employee'])
  receiverRole?: 'admin' | 'employee';
}
