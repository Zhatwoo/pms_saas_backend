import { IsNotEmpty, IsString, IsOptional, IsEnum } from 'class-validator';

export enum BranchStatus {
  ACTIVE = 'Active',
  INACTIVE = 'Inactive',
  PROCESS = 'Process',
  TERMINATED = 'Terminated',
}

export class CreateBranchDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  location: string;

  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus = BranchStatus.ACTIVE;
}
