import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateFundRequestDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amountRequested: number;

  @IsString()
  purpose: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsUUID()
  receiverUserId?: string;

  @IsOptional()
  @IsIn(['admin', 'employee'])
  receiverRole?: 'admin' | 'employee';
}
