import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

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
}
