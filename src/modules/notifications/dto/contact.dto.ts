import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class ContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message: string;
}
