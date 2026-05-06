import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CustomerNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;
}
