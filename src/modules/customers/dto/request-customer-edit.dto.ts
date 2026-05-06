import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class RequestCustomerEditDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  notes!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  field?: string;

  @IsOptional()
  @IsString()
  @IsIn(['freeform', 'field'])
  mode?: string;
}
