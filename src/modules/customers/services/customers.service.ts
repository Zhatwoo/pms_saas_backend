import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import { Role } from '../../../common/enums';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { normalizeCustomerFullName } from '../../../common/utils/customer-name.util';

type CustomerRow = {
  id: string;
  full_name: string;
  branch_id: string | null;
};

type CustomerVisualRow = {
  profile_photo: string | null;
  id_photo: string | null;
  id_back_photo: string | null;
  created_at: string;
};

type TransactionVisualRow = {
  profile_photo: string | null;
  id_photo: string | null;
  id_back_photo: string | null;
  related_pawned_item_id: string | null;
  transaction_date: string | null;
  transaction_time: string | null;
};

type CustomerMergeCandidate = {
  id: string;
  full_name: string;
  branch_id: string | null;
  created_at: string;
};

@Injectable()
export class CustomersService {
  constructor(private readonly supabase: SupabaseService) {}

  private async resolveStorageUrl(storedUrl?: string | null): Promise<string> {
    if (!storedUrl) {
      return '';
    }

    const publicPrefix = '/storage/v1/object/public/';
    const signedPrefix = '/storage/v1/object/sign/';
    const altPublicPrefix = 'storage/v1/object/public/';
    const altSignedPrefix = 'storage/v1/object/sign/';

    if (!storedUrl.startsWith('http')) {

      let storagePath = storedUrl;
      if (storagePath.startsWith(publicPrefix)) {
        storagePath = storagePath.slice(publicPrefix.length);
      } else if (storagePath.startsWith(signedPrefix)) {
        storagePath = storagePath.slice(signedPrefix.length);
      } else if (storagePath.startsWith(altPublicPrefix)) {
        storagePath = storagePath.slice(altPublicPrefix.length);
      } else if (storagePath.startsWith(altSignedPrefix)) {
        storagePath = storagePath.slice(altSignedPrefix.length);
      } else {
        storagePath = storagePath.replace(/^\/+/, '');
      }

      const [bucketName, ...objectPathParts] = storagePath.split('/');
      const objectPath = objectPathParts.join('/');

      if (!bucketName || !objectPath) {
        return storedUrl;
      }

      const { data, error } = await this.supabase
        .getClient()
        .storage.from(bucketName)
        .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

      if (error || !data?.signedUrl) {
        return storedUrl;
      }

      return data.signedUrl;
    }

    try {
      const parsedUrl = new URL(storedUrl);
      const storagePrefixes = ['/storage/v1/object/public/', '/storage/v1/object/sign/'];

      const matchedPrefix = storagePrefixes.find((prefix) => parsedUrl.pathname.includes(prefix));
      if (!matchedPrefix) {
        return storedUrl;
      }

      const storagePath = parsedUrl.pathname.split(matchedPrefix)[1];
      if (!storagePath) {
        return storedUrl;
      }

      const [bucketName, ...objectPathParts] = storagePath.split('/');
      const objectPath = objectPathParts.join('/');

      if (!bucketName || !objectPath) {
        return storedUrl;
      }

      const { data, error } = await this.supabase
        .getClient()
        .storage.from(bucketName)
        .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

      if (error || !data?.signedUrl) {
        return storedUrl;
      }

      return data.signedUrl;
    } catch {
      return storedUrl;
    }
  }

  private resolveMergeBranchId(user: UserWithBranch, branchId?: string) {
    if (user.role === Role.SUPER_ADMIN) {
      const normalizedBranchId = branchId?.trim() || '';
      if (!normalizedBranchId) {
        throw new BadRequestException('branchId is required for customer merging');
      }

      return normalizedBranchId;
    }

    return requireUserBranchId(user);
  }

  private async resolveCustomerNameGroup(user: UserWithBranch, customer: CustomerRow) {
    const client = this.supabase.getClient();
    let query = client.from('customers').select('id, full_name, branch_id');

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const targetName = normalizeCustomerFullName(customer.full_name);
    const matches = (data || []).filter((candidate: CustomerRow) =>
      normalizeCustomerFullName(candidate.full_name) === targetName,
    );

    const matchingIds = matches.map((candidate: CustomerRow) => candidate.id);
    if (!matchingIds.includes(customer.id)) {
      matchingIds.unshift(customer.id);
    }

    const matchingBranches = new Set(
      matches.map((candidate: CustomerRow) => candidate.branch_id).filter(Boolean),
    );

    return {
      matchingIds,
      matchingCustomerCount: matchingIds.length,
      matchingBranchCount: matchingBranches.size,
    };
  }

  private async resolveCustomerVisuals(customerIds: string[]) {
    const client = this.supabase.getClient();

    const { data: pawnedItems, error: pawnedItemsError } = await client
      .from('pawned_items')
      .select('id, profile_photo, id_photo, id_back_photo, customer_id, created_at')
      .in('customer_id', customerIds)
      .order('created_at', { ascending: false })
      .limit(50);

    if (pawnedItemsError) {
      throw new InternalServerErrorException(pawnedItemsError.message);
    }

    const matchingPawnedItemIds = (pawnedItems || [])
      .map((row: { id?: string }) => row.id)
      .filter((id): id is string => Boolean(id));

    const transactions = matchingPawnedItemIds.length > 0
      ? await (async () => {
          const { data, error } = await client
            .from('transactions')
            .select('profile_photo, id_photo, id_back_photo, related_pawned_item_id, transaction_date, transaction_time')
            .in('related_pawned_item_id', matchingPawnedItemIds)
            .order('transaction_date', { ascending: false })
            .order('transaction_time', { ascending: false })
            .limit(50);

          if (error) {
            throw new InternalServerErrorException(error.message);
          }

          return data || [];
        })()
      : [];

    const latestVisual = (pawnedItems || []).find((row: CustomerVisualRow) =>
      Boolean(row.profile_photo || row.id_photo || row.id_back_photo),
    ) as CustomerVisualRow | undefined;

    const latestTransactionVisual = (transactions || []).find((row: TransactionVisualRow) =>
      Boolean(row.profile_photo || row.id_photo || row.id_back_photo),
    ) as TransactionVisualRow | undefined;

    const latestPawnedVisual = (pawnedItems || []).find((row: CustomerVisualRow) =>
      Boolean(row.profile_photo || row.id_photo || row.id_back_photo),
    ) as CustomerVisualRow | undefined;

    const latestProfilePhoto = latestTransactionVisual?.profile_photo
      ? latestTransactionVisual
      : (transactions || []).find((row: TransactionVisualRow) => Boolean(row.profile_photo))
        ?? (pawnedItems || []).find((row: CustomerVisualRow) => Boolean(row.profile_photo));
    const latestFrontPhoto = latestTransactionVisual?.id_photo
      ? latestTransactionVisual
      : (transactions || []).find((row: TransactionVisualRow) => Boolean(row.id_photo))
        ?? (pawnedItems || []).find((row: CustomerVisualRow) => Boolean(row.id_photo));
    const latestBackPhoto = latestTransactionVisual?.id_back_photo
      ? latestTransactionVisual
      : (transactions || []).find((row: TransactionVisualRow) => Boolean(row.id_back_photo))
        ?? (pawnedItems || []).find((row: CustomerVisualRow) => Boolean(row.id_back_photo));

    const [profilePhotoUrl, idFrontPhotoUrl, idBackPhotoUrl] = await Promise.all([
      this.resolveStorageUrl(latestProfilePhoto?.profile_photo ?? latestTransactionVisual?.profile_photo ?? latestPawnedVisual?.profile_photo),
      this.resolveStorageUrl(latestFrontPhoto?.id_photo ?? latestTransactionVisual?.id_photo ?? latestPawnedVisual?.id_photo),
      this.resolveStorageUrl(latestBackPhoto?.id_back_photo ?? latestTransactionVisual?.id_back_photo ?? latestPawnedVisual?.id_back_photo),
    ]);

    return {
      profilePhotoUrl: profilePhotoUrl || null,
      idFrontPhotoUrl: idFrontPhotoUrl || null,
      idBackPhotoUrl: idBackPhotoUrl || null,
    };
  }

  async create(user: UserWithBranch, dto: CreateCustomerDto) {
    const client = this.supabase.getClient();
    const payload =
      user.role === Role.SUPER_ADMIN
        ? { ...dto }
        : {
            ...dto,
            branch_id: requireUserBranchId(user),
          };

    const { data, error } = await client
      .from('customers')
      .insert([payload])
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async findAll(user: UserWithBranch, branchId?: string) {
    const client = this.supabase.getClient();
    let query = client
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false });

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    } else if (branchId) {
      query = query.eq('branch_id', branchId);
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const rows = (data || []) as CustomerRow[];
    const uniqueCustomers = new Map<string, CustomerRow & { matching_customer_count: number }>();

    for (const row of rows) {
      const normalizedName = normalizeCustomerFullName(row.full_name);
      const existing = uniqueCustomers.get(normalizedName);

      if (!existing) {
        uniqueCustomers.set(normalizedName, {
          ...(row as CustomerRow),
          matching_customer_count: 1,
        });
        continue;
      }

      existing.matching_customer_count += 1;
    }

    return Array.from(uniqueCustomers.values());
  }

  async findOne(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    let query = client.from('customers').select('*').eq('id', id);

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    }

    const { data, error } = await query.single();
    if (error) {
      if (
        error.code === 'PGRST116' ||
        error.code === '22P02' ||
        error.message?.toLowerCase().includes('invalid input syntax')
      ) {
        return null;
      }

      throw new InternalServerErrorException(error.message);
    }

    const group = await this.resolveCustomerNameGroup(user, data as CustomerRow);
    const visuals = await this.resolveCustomerVisuals(group.matchingIds);
    let branchName: string | null = null;

    if (data.branch_id) {
      const { data: branch, error: branchError } = await client
        .from('branches')
        .select('name')
        .eq('id', data.branch_id)
        .maybeSingle<{ name: string }>();

      if (branchError) {
        throw new InternalServerErrorException(branchError.message);
      }

      branchName = branch?.name ?? null;
    }

    return {
      ...data,
      branch_name: branchName,
      profile_photo_url: visuals.profilePhotoUrl,
      id_front_photo_url: visuals.idFrontPhotoUrl,
      id_back_photo_url: visuals.idBackPhotoUrl,
      matching_customer_count: group.matchingCustomerCount,
      matching_branch_count: group.matchingBranchCount,
      matching_customer_ids: group.matchingIds,
    };
  }

  async findCustomerActivityLogs(user: UserWithBranch, customerId: string) {
    const client = this.supabase.getClient();
    const customer = await this.findOne(user, customerId);

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const customerGroup = await this.resolveCustomerNameGroup(user, customer as CustomerRow);

    let query = client
      .from('activity_logs')
      .select('id, action, details, created_at, users(full_name, email)')
      .order('created_at', { ascending: false });

    if (user.role !== Role.SUPER_ADMIN) {
      query = query.eq('branch_id', requireUserBranchId(user));
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const customerLogs = (data || [])
      .map((log: any) => {
        const rawDetails = typeof log.details === 'string' ? log.details : '';

        let parsedDetails: Record<string, unknown> = {};
        if (rawDetails) {
          try {
            parsedDetails = JSON.parse(rawDetails) as Record<string, unknown>;
          } catch {
            parsedDetails = {};
          }
        }

        const detailsCustomerId =
          typeof parsedDetails.customerId === 'string'
            ? parsedDetails.customerId
            : typeof parsedDetails.customer_id === 'string'
              ? parsedDetails.customer_id
              : null;

        if (!customerGroup.matchingIds.includes(detailsCustomerId || '')) {
          return null;
        }

        return {
          id: log.id,
          action: log.action,
          details: parsedDetails,
          createdAt: log.created_at,
          actorName: log.users?.full_name || log.users?.email || 'System',
        };
      })
      .filter(Boolean);

    return customerLogs;
  }

  async addCustomerNote(
    user: UserWithBranch & { id: string },
    customerId: string,
    title?: string,
    note?: string,
  ) {
    const client = this.supabase.getClient();
    const customer = await this.findOne(user, customerId);

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const trimmedNote = note?.trim() ?? '';
    if (!trimmedNote) {
      throw new BadRequestException('Note is required');
    }

    const trimmedTitle = title?.trim() || 'Manual Note';

    const { error } = await client.from('activity_logs').insert({
      user_id: user.id,
      branch_id: customer.branch_id || null,
      action: 'CUSTOMER_NOTE_ADDED',
      details: JSON.stringify({
        customerId,
        title: trimmedTitle,
        note: trimmedNote,
      }),
    });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { message: 'Note saved successfully' };
  }

  // Update customer information (admin / super admin only)
  async update(user: UserWithBranch, id: string, updateDto: any) {
    const client = this.supabase.getClient();
    // Ensure the customer exists and is within the allowed branch scope
    const existing = await this.findOne(user, id);
    if (!existing) {
      throw new NotFoundException('Customer not found');
    }
    const { error } = await client
      .from('customers')
      .update(updateDto)
      .eq('id', id);
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return { message: 'Customer updated successfully' };
  }

  // Employee request to edit customer details (adds a note for review)
  async requestEdit(user: AuthenticatedUserProfile, id: string, notes: string) {
    const client = this.supabase.getClient();
    const customer = await this.findOne(user, id);
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    const trimmed = notes?.trim();
    if (!trimmed) {
      throw new BadRequestException('Edit request notes are required');
    }
    const { error } = await client.from('activity_logs').insert({
      user_id: user.id,
      branch_id: customer.branch_id || null,
      action: 'CUSTOMER_EDIT_REQUESTED',
      details: JSON.stringify({ customerId: id, notes: trimmed }),
    });
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return { message: 'Edit request submitted successfully' };
  }

  async mergeDuplicateCustomers(
    user: UserWithBranch & { id: string },
    branchId?: string,
  ) {
    const client = this.supabase.getClient();
    const targetBranchId = this.resolveMergeBranchId(user, branchId);

    const { data: customers, error: customersError } = await client
      .from('customers')
      .select('id, full_name, branch_id, created_at')
      .eq('branch_id', targetBranchId)
      .order('created_at', { ascending: true });

    if (customersError) {
      throw new InternalServerErrorException(customersError.message);
    }

    const groupedCustomers = new Map<string, CustomerMergeCandidate[]>();

    for (const customer of (customers || []) as CustomerMergeCandidate[]) {
      const normalizedName = normalizeCustomerFullName(customer.full_name);
      const group = groupedCustomers.get(normalizedName) || [];
      group.push(customer);
      groupedCustomers.set(normalizedName, group);
    }

    const mergeSummaries: Array<{
      canonicalCustomerId: string;
      canonicalCustomerName: string;
      mergedCustomerIds: string[];
      mergedCount: number;
      pawnedItemsReassigned: number;
      activityLogsUpdated: number;
    }> = [];

    const { data: activityLogs, error: activityLogsError } = await client
      .from('activity_logs')
      .select('id, details')
      .eq('branch_id', targetBranchId)
      .order('created_at', { ascending: true });

    if (activityLogsError) {
      throw new InternalServerErrorException(activityLogsError.message);
    }

    for (const [normalizedName, group] of groupedCustomers.entries()) {
      if (group.length <= 1) {
        continue;
      }

      const canonicalCustomer = group[0];
      const duplicateCustomers = group.slice(1);
      const duplicateIds = duplicateCustomers.map((customer) => customer.id);
      const duplicateIdSet = new Set(duplicateIds);

      const { data: pawnedRows, error: pawnedError } = await client
        .from('pawned_items')
        .update({ customer_id: canonicalCustomer.id })
        .in('customer_id', duplicateIds)
        .select('id');

      if (pawnedError) {
        throw new InternalServerErrorException(pawnedError.message);
      }

      let activityLogsUpdated = 0;

      for (const log of (activityLogs || []) as Array<{ id: string; details: string | null }>) {
        const rawDetails = typeof log.details === 'string' ? log.details : '';
        if (!rawDetails) {
          continue;
        }

        let parsedDetails: Record<string, unknown> | null = null;
        try {
          parsedDetails = JSON.parse(rawDetails) as Record<string, unknown>;
        } catch {
          parsedDetails = null;
        }

        if (!parsedDetails) {
          continue;
        }

        const detailsCustomerId =
          typeof parsedDetails.customerId === 'string'
            ? parsedDetails.customerId
            : typeof parsedDetails.customer_id === 'string'
              ? parsedDetails.customer_id
              : null;

        if (!detailsCustomerId || !duplicateIdSet.has(detailsCustomerId)) {
          continue;
        }

        const nextDetails = {
          ...parsedDetails,
          customerId: canonicalCustomer.id,
          customer_id: canonicalCustomer.id,
        };

        const { error: updateError } = await client
          .from('activity_logs')
          .update({ details: JSON.stringify(nextDetails) })
          .eq('id', log.id);

        if (updateError) {
          throw new InternalServerErrorException(updateError.message);
        }

        activityLogsUpdated += 1;
      }

      const { error: deleteError } = await client
        .from('customers')
        .delete()
        .in('id', duplicateIds);

      if (deleteError) {
        throw new InternalServerErrorException(deleteError.message);
      }

      mergeSummaries.push({
        canonicalCustomerId: canonicalCustomer.id,
        canonicalCustomerName: canonicalCustomer.full_name,
        mergedCustomerIds: duplicateIds,
        mergedCount: duplicateIds.length,
        pawnedItemsReassigned: (pawnedRows || []).length,
        activityLogsUpdated,
      });

      await client.from('activity_logs').insert({
        user_id: user.id,
        branch_id: targetBranchId,
        action: 'CUSTOMER_DUPLICATES_MERGED',
        details: JSON.stringify({
          normalizedName,
          canonicalCustomerId: canonicalCustomer.id,
          canonicalCustomerName: canonicalCustomer.full_name,
          mergedCustomerIds: duplicateIds,
          mergedCount: duplicateIds.length,
        }),
      });
    }

    return {
      branchId: targetBranchId,
      mergedGroups: mergeSummaries.length,
      mergeSummaries,
    };
  }
}
