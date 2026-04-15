import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class VerifyPasswordDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  password: string;
}
