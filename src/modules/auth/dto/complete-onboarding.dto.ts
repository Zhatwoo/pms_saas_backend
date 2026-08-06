import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { PHONE_REGEX } from '../../branches/dto/create-branch.dto';

export class CompleteOnboardingDto {
  @IsNotEmpty()
  @IsString()
  branchName: string;

  @IsNotEmpty()
  @IsString()
  location: string;

  @IsNotEmpty()
  @IsString()
  contactNumber: string;
}
