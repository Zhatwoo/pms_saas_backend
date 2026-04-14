import { IsUUID } from 'class-validator';

export class TransferUserBranchDto {
  @IsUUID()
  branchId!: string;
}
