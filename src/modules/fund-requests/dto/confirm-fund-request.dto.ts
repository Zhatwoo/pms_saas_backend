import { IsOptional, IsString } from 'class-validator';

export class ConfirmFundRequestDto {
  @IsOptional()
  @IsString()
  confirmationNotes?: string;
}
