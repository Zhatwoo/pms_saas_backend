import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateDirectTransferDto {
  @IsUUID()
  toBranchId: string;

  @IsOptional()
  @IsUUID()
  fromBranchId?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsIn(['cash', 'bank_transfer', 'ewallet', 'check', 'other'])
  transferMode?: 'cash' | 'bank_transfer' | 'ewallet' | 'check' | 'other';

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  transferReference?: string;

  @IsOptional()
  @IsUUID()
  receiverUserId?: string;

  @IsOptional()
  @IsIn(['admin', 'employee'])
  receiverRole?: 'admin' | 'employee';
}
