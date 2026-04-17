import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import { CreatePawnTicketDto } from '../dto/create-pawn-ticket.dto';

@Injectable()
export class PawnTicketsService {
  constructor(private readonly supabase: SupabaseService) {}

  private isPawnTicketMigrationMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const rec = error as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message : '';

    return (
      message.includes("Could not find the table 'public.customers'") ||
      message.includes("column 'customer_id' does not exist") ||
      message.includes('relation "public.customers" does not exist')
    );
  }

  private throwMissingMigrationError() {
    throw new InternalServerErrorException(
      'Database schema is incomplete for pawn tickets. Apply migration: PMS_backend/supabase/migrations/009_create_customers_and_pawn_ticket_relations.sql, then refresh the Supabase schema cache.',
    );
  }

  private generateTransactionNo() {
    return `PAWN-${Date.now()}`;
  }

  private generateItemId(unitCode?: string) {
    if (unitCode && unitCode.trim()) {
      return unitCode.trim().toUpperCase();
    }
    return `PWN-${Date.now()}`;
  }

  async create(user: AuthenticatedUserProfile, dto: CreatePawnTicketDto) {
    const client = this.supabase.getClient();
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? dto.branchId ?? requireUserBranchId(user)
        : requireUserBranchId(user);
    const branchName = dto.branchName ?? user.branchName ?? 'Unknown Branch';

    // 1. Process Photos if present
    let profilePhotoUrl: string | null = null;
    let idPhotoUrl: string | null = null;

    const bucketName = dto.customer.idPresented === 'No ID / None' 
      ? 'profile_image' 
      : 'id_pictures';

    if (dto.item.profilePhoto) {
      profilePhotoUrl = await this.uploadPhoto(
        dto.item.profilePhoto,
        `profile_${Date.now()}.jpg`,
        bucketName
      );
    }

    if (dto.item.idPhoto) {
      idPhotoUrl = await this.uploadPhoto(
        dto.item.idPhoto,
        `id_${Date.now()}.jpg`,
        bucketName
      );
    }

    const customerPayload = {
      full_name: dto.customer.fullName.trim(),
      address: dto.customer.address.trim(),
      barangay: dto.customer.barangay?.trim() ?? null,
      city: dto.customer.city?.trim() ?? null,
      province: dto.customer.province?.trim() ?? null,
      contact_number: dto.customer.contactNumber?.trim() ?? null,
      email: dto.customer.email?.trim() ?? null,
      id_presented: dto.customer.idPresented?.trim() ?? null,
      branch_id: branchId,
    };

    const { data: customer, error: customerError } = await client
      .from('customers')
      .insert([customerPayload])
      .select()
      .single();

    if (customerError) {
      if (this.isPawnTicketMigrationMissing(customerError)) {
        this.throwMissingMigrationError();
      }
      throw new InternalServerErrorException(customerError.message);
    }

    const itemPayload = {
      item_id: this.generateItemId(dto.item.unitCode),
      item_name: dto.item.unitName.trim(),
      category: dto.item.category?.trim() || 'Miscellaneous',
      branch_id: branchId,
      branch: branchName,
      pawn_date: dto.item.purchasedDate || new Date().toISOString().split('T')[0],
      status: 'Active',
      remarks: dto.item.remarks?.trim() ?? '',
      qr_code: dto.item.qrCode ?? null,
      profile_photo: profilePhotoUrl,
      id_photo: idPhotoUrl,
      condition: dto.item.condition?.trim() ?? '',
      serial_number: dto.item.serialNumber?.trim() ?? '',
      items_included: dto.item.itemsIncluded?.trim() ?? '',
      memory_storage: dto.item.memoryStorage?.trim() ?? '',
      condition_report: dto.item.condition?.trim() ?? '',
      customer_id: customer.id,
      amount: dto.transaction.pawnAmount ?? 0,
    };

    const { data: pawnedItem, error: pawnedError } = await client
      .from('pawned_items')
      .insert([itemPayload])
      .select()
      .single();

    if (pawnedError) {
      if (this.isPawnTicketMigrationMissing(pawnedError)) {
        this.throwMissingMigrationError();
      }
      throw new InternalServerErrorException(pawnedError.message);
    }

    const transactionPayload = {
      transaction_no: this.generateTransactionNo(),
      branch_id: branchId,
      branch: branchName,
      purpose: 'Pawn',
      transaction_date: new Date().toISOString().split('T')[0],
      transaction_time: new Date().toTimeString().slice(0, 8),
      cash_in: dto.transaction.pawnAmount ?? 0,
      cash_out: 0,
      return_amount: dto.transaction.returnAmount ?? 0,
      unit: dto.item.unitName.trim(),
      unit_code: dto.item.unitCode?.trim() ?? null,
      pawn_amount: dto.transaction.pawnAmount ?? 0,
      storage_fee: dto.transaction.storageFee ?? 0,
      details: dto.transaction.details?.trim() ?? null,
      related_pawned_item_id: pawnedItem.id,
      profile_photo: profilePhotoUrl,
      id_photo: idPhotoUrl,
    };

    const { data: transaction, error: transactionError } = await client
      .from('transactions')
      .insert([transactionPayload])
      .select()
      .single();

    if (transactionError) {
      throw new InternalServerErrorException(transactionError.message);
    }

    return {
      customer,
      pawnedItem,
      transaction,
    };
  }

  async generateNextUnitCode(user: AuthenticatedUserProfile) {
    const client = this.supabase.getClient();
    const branchId = requireUserBranchId(user);

    // 1. Get branch code
    const { data: branch, error: branchError } = await client
      .from('branches')
      .select('branch_code')
      .eq('id', branchId)
      .single();

    if (branchError || !branch) {
      throw new InternalServerErrorException(branchError?.message || 'Branch code not found');
    }

    // 2. Get the most recent items to find the highest sequence number
    // We fetch the latest items for this branch to see what the last number used was.
    const { data: items, error: itemsError } = await client
      .from('pawned_items')
      .select('item_id')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (itemsError) {
      throw new InternalServerErrorException(itemsError.message);
    }

    let maxNumber = 0;
    
    // Parse the item_id (unit_code) to find the numeric sequence part
    // Format: [branch]-jclb-[number]
    if (items && items.length > 0) {
      items.forEach(item => {
        const parts = item.item_id.split('-');
        if (parts.length === 3) {
          const numPart = parseInt(parts[2], 10);
          if (!isNaN(numPart) && numPart > maxNumber) {
            maxNumber = numPart;
          }
        }
      });
    }

    const nextNumber = maxNumber + 1;
    const formattedNumber = String(nextNumber).padStart(5, '0');
    
    return {
      unitCode: `${branch.branch_code}-jclb-${formattedNumber}`
    };
  }

  private async uploadPhoto(
    base64: string,
    path: string,
    bucket: string,
  ): Promise<string> {
    const client = this.supabase.getClient();
    // Remove data:image/jpeg;base64, or similar prefix
    const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
    const buf = Buffer.from(base64Data, 'base64');

    const { data, error } = await client.storage
      .from(bucket)
      .upload(path, buf, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      throw new InternalServerErrorException(
        `Photo upload to ${bucket} failed: ${error.message}`,
      );
    }

    const {
      data: { publicUrl },
    } = client.storage.from(bucket).getPublicUrl(path);

    return publicUrl;
  }
}
