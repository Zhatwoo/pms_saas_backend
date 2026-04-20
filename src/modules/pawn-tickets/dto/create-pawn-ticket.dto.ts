import { IsString, IsOptional, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePawnTicketCustomerDto {
  @IsString()
  fullName!: string;

  @IsString()
  address!: string;

  @IsOptional()
  @IsString()
  barangay?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  province?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  idPresented?: string;
}

export class CreatePawnTicketItemDto {
  @IsOptional()
  @IsString()
  unitCode?: string;

  @IsString()
  unitName!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  itemsIncluded?: string;

  @IsOptional()
  @IsString()
  condition?: string;

  @IsOptional()
  @IsString()
  memoryStorage?: string;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  purchasedDate?: string;

  @IsOptional()
  @IsString()
  qrCode?: string;

  @IsOptional()
  @IsString()
  profilePhoto?: string;

  @IsOptional()
  @IsString()
  idPhoto?: string;

  @IsOptional()
  @IsString()
  idBackPhoto?: string;
}

export class CreatePawnTicketTransactionDto {
  @IsNumber()
  pawnAmount!: number;

  @IsOptional()
  @IsNumber()
  storageFee?: number;

  @IsOptional()
  @IsNumber()
  returnAmount?: number;

  @IsOptional()
  @IsString()
  details?: string;
}

export class CreatePawnTicketDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @ValidateNested()
  @Type(() => CreatePawnTicketCustomerDto)
  customer!: CreatePawnTicketCustomerDto;

  @ValidateNested()
  @Type(() => CreatePawnTicketItemDto)
  item!: CreatePawnTicketItemDto;

  @ValidateNested()
  @Type(() => CreatePawnTicketTransactionDto)
  transaction!: CreatePawnTicketTransactionDto;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  branchName?: string;
}
