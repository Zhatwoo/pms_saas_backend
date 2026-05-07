import {
  IsArray,
  IsString,
  IsOptional,
  IsNumber,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
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
  region?: string;

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
  @Type(() => Number)
  @IsNumber()
  @Min(0)
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
  @IsArray()
  @IsString({ each: true })
  itemPhotos?: string[];

  @IsOptional()
  @IsString()
  idPhoto?: string;

  @IsOptional()
  @IsString()
  idBackPhoto?: string;
}

export class CreatePawnTicketTransactionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  pawnAmount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  storageFee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  returnAmount?: number;

  @IsOptional()
  @IsString()
  transactionDate?: string;

  @IsOptional()
  @IsString()
  transactionTime?: string;

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
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  branchName?: string;
}
