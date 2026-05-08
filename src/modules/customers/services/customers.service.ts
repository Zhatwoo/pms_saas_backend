import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../../infrastructure/prisma';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { NotificationsService } from '../../notifications/services/notifications.service';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import { Role } from '../../../common/enums';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { UpdateCustomerDto } from '../dto/update-customer.dto';
import { ListCustomersDto } from '../dto/list-customers.dto';
import { normalizeCustomerFullName } from '../../../common/utils/customer-name.util';

type CustomerRow = {
  id: string;
  full_name: string;
  branch_id: string | null;
  created_at?: Date | string;
};

type CustomerMergeCandidate = {
  id: string;
  full_name: string;
  branch_id: string | null;
  created_at: Date;
};

type ProcessedCustomerLogTarget = {
  id: string;
  full_name: string;
  branch_id: string | null;
  branch_name?: string | null;
};

const CUSTOMER_SAFE_SELECT = {
  id: true,
  full_name: true,
  contact_number: true,
  email: true,
  id_presented: true,
  barangay: true,
  city: true,
  region: true,
  branch_id: true,
  created_at: true,
} satisfies Prisma.customersSelect;

const CUSTOMER_FULL_SELECT = {
  id: true,
  full_name: true,
  address: true,
  barangay: true,
  city: true,
  region: true,
  contact_number: true,
  email: true,
  id_presented: true,
  branch_id: true,
  created_at: true,
  updated_at: true,
  branches: { select: { name: true } },
} satisfies Prisma.customersSelect;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly notificationsService: NotificationsService,
    private readonly encryption: EncryptionService,
  ) {}

  private customerScopeWhere(
    user: UserWithBranch,
    branchId?: string,
  ): Prisma.customersWhereInput {
    const where: Prisma.customersWhereInput = { deleted_at: null };

    if (user.role === Role.SUPER_ADMIN) {
      if (branchId) {
        where.branch_id = branchId;
      }
      return where;
    }

    where.branch_id = requireUserBranchId(user);
    return where;
  }

  private async resolveStorageUrl(storedUrl?: string | null): Promise<string> {
    if (!storedUrl) return '';

    const prefixes = [
      '/storage/v1/object/public/',
      '/storage/v1/object/sign/',
      'storage/v1/object/public/',
      'storage/v1/object/sign/',
    ];

    const toStoragePath = (value: string) => {
      if (!value.startsWith('http')) {
        const matched = prefixes.find((prefix) => value.startsWith(prefix));
        return matched
          ? value.slice(matched.length)
          : value.replace(/^\/+/, '');
      }

      try {
        const parsed = new URL(value);
        const matched = prefixes
          .filter((prefix) => prefix.startsWith('/'))
          .find((prefix) => parsed.pathname.includes(prefix));
        return matched ? parsed.pathname.split(matched)[1] : '';
      } catch {
        return '';
      }
    };

    const storagePath = toStoragePath(storedUrl);
    if (!storagePath) return storedUrl;

    const [bucketName, ...objectPathParts] = storagePath.split('/');
    const objectPath = objectPathParts.join('/');
    if (!bucketName || !objectPath) return storedUrl;

    const { data, error } = await this.supabase
      .getClient()
      .storage.from(bucketName)
      .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

    return error || !data?.signedUrl ? storedUrl : data.signedUrl;
  }

  private resolveMergeBranchId(user: UserWithBranch, branchId?: string) {
    if (user.role === Role.SUPER_ADMIN) {
      const normalizedBranchId = branchId?.trim() || '';
      if (!normalizedBranchId) {
        throw new BadRequestException(
          'branchId is required for customer merging',
        );
      }
      return normalizedBranchId;
    }

    return requireUserBranchId(user);
  }

  private async resolveCustomerNameGroup(
    user: UserWithBranch,
    customer: CustomerRow,
  ) {
    const candidates = await this.prisma.customers.findMany({
      where: this.customerScopeWhere(user),
      select: { id: true, full_name: true, branch_id: true },
    });

    const targetName = normalizeCustomerFullName(customer.full_name);
    const matches = candidates.filter(
      (candidate) =>
        normalizeCustomerFullName(candidate.full_name) === targetName,
    );

    const matchingIds = matches.map((candidate) => candidate.id);
    if (!matchingIds.includes(customer.id)) matchingIds.unshift(customer.id);

    const matchingBranches = new Set(
      matches.map((candidate) => candidate.branch_id).filter(Boolean),
    );

    return {
      matchingIds,
      matchingCustomerCount: matchingIds.length,
      matchingBranchCount: matchingBranches.size,
    };
  }

  private async resolveCustomerVisuals(customerIds: string[]) {
    const pawnedItems = await this.prisma.pawned_items.findMany({
      where: { customer_id: { in: customerIds } },
      select: {
        id: true,
        profile_photo: true,
        id_photo: true,
        id_back_photo: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    const pawnedItemIds = pawnedItems.map((row) => row.id);
    const transactions =
      pawnedItemIds.length > 0
        ? await this.prisma.transactions.findMany({
            where: { related_pawned_item_id: { in: pawnedItemIds } },
            select: {
              profile_photo: true,
              id_photo: true,
              id_back_photo: true,
              related_pawned_item_id: true,
              transaction_date: true,
              transaction_time: true,
            },
            orderBy: [
              { transaction_date: 'desc' },
              { transaction_time: 'desc' },
            ],
            take: 50,
          })
        : [];

    const latestPawnedVisual = pawnedItems.find((row) =>
      Boolean(row.profile_photo || row.id_photo || row.id_back_photo),
    );
    const latestTransactionVisual = transactions.find((row) =>
      Boolean(row.profile_photo || row.id_photo || row.id_back_photo),
    );
    const latestProfilePhoto =
      transactions.find((row) => Boolean(row.profile_photo)) ??
      pawnedItems.find((row) => Boolean(row.profile_photo));
    const latestFrontPhoto =
      transactions.find((row) => Boolean(row.id_photo)) ??
      pawnedItems.find((row) => Boolean(row.id_photo));
    const latestBackPhoto =
      transactions.find((row) => Boolean(row.id_back_photo)) ??
      pawnedItems.find((row) => Boolean(row.id_back_photo));

    const [profilePhotoUrl, idFrontPhotoUrl, idBackPhotoUrl] =
      await Promise.all([
        this.resolveStorageUrl(
          latestProfilePhoto?.profile_photo ??
            latestTransactionVisual?.profile_photo ??
            latestPawnedVisual?.profile_photo,
        ),
        this.resolveStorageUrl(
          latestFrontPhoto?.id_photo ??
            latestTransactionVisual?.id_photo ??
            latestPawnedVisual?.id_photo,
        ),
        this.resolveStorageUrl(
          latestBackPhoto?.id_back_photo ??
            latestTransactionVisual?.id_back_photo ??
            latestPawnedVisual?.id_back_photo,
        ),
      ]);

    return {
      profilePhotoUrl: profilePhotoUrl || null,
      idFrontPhotoUrl: idFrontPhotoUrl || null,
      idBackPhotoUrl: idBackPhotoUrl || null,
    };
  }

  async create(user: UserWithBranch, dto: CreateCustomerDto) {
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? dto.branch_id
        : requireUserBranchId(user);

    if (!branchId) {
      throw new BadRequestException('branch_id is required');
    }

    const payload: Prisma.customersUncheckedCreateInput = {
      full_name: dto.full_name.trim(),
      address: dto.address.trim(),
      barangay: dto.barangay?.trim() || null,
      city: dto.city?.trim() || null,
      region: dto.region?.trim() || null,
      contact_number: dto.contact_number?.trim() || null,
      email: dto.email?.trim().toLowerCase() || null,
      id_presented: dto.id_presented?.trim() || null,
      branch_id: branchId,
    };
    this.encryption.applyCustomerFieldsForWrite(payload);

    const created = await this.prisma.customers.create({
      data: payload,
      select:
        user.role === Role.EMPLOYEE
          ? CUSTOMER_SAFE_SELECT
          : CUSTOMER_FULL_SELECT,
    });
    return this.encryption.decryptCustomerRow(created) as typeof created;
  }

  async findAll(
    user: UserWithBranch,
    query: ListCustomersDto = new ListCustomersDto(),
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.customersWhereInput = this.customerScopeWhere(
      user,
      query.branchId,
    );

    if (query.search?.trim()) {
      where.full_name = { contains: query.search.trim(), mode: 'insensitive' };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customers.findMany({
        where,
        select:
          user.role === Role.EMPLOYEE
            ? CUSTOMER_SAFE_SELECT
            : CUSTOMER_FULL_SELECT,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.customers.count({ where }),
    ]);

    const uniqueCustomers = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const dec = this.encryption.decryptCustomerRow(
        row,
      ) as (typeof rows)[number];
      const branch = (dec as { branches?: { name?: string | null } | null })
        .branches;
      const normalizedName = normalizeCustomerFullName(dec.full_name);
      const existing = uniqueCustomers.get(normalizedName);
      if (!existing) {
        uniqueCustomers.set(normalizedName, {
          ...dec,
          branch_name: branch?.name ?? null,
          branches: undefined,
          matching_customer_count: 1,
        });
        continue;
      }
      existing.matching_customer_count =
        Number(existing.matching_customer_count) + 1;
    }

    return {
      data: Array.from(uniqueCustomers.values()),
      meta: { page, limit, total },
    };
  }

  async findOne(user: UserWithBranch, id: string) {
    const customer = await this.prisma.customers.findFirst({
      where: { id, ...this.customerScopeWhere(user) },
      select: CUSTOMER_FULL_SELECT,
    });

    if (!customer) return null;

    const decrypted = this.encryption.decryptCustomerRow(
      customer,
    ) as NonNullable<typeof customer>;

    const group = await this.resolveCustomerNameGroup(user, decrypted);
    const visuals = await this.resolveCustomerVisuals(group.matchingIds);

    return {
      ...decrypted,
      branches: undefined,
      branch_name: decrypted.branches?.name ?? null,
      profile_photo_url: visuals.profilePhotoUrl,
      id_front_photo_url: visuals.idFrontPhotoUrl,
      id_back_photo_url: visuals.idBackPhotoUrl,
      matching_customer_count: group.matchingCustomerCount,
      matching_branch_count: group.matchingBranchCount,
      matching_customer_ids: group.matchingIds,
    };
  }

  async findCustomerActivityLogs(user: UserWithBranch, customerId: string) {
    const customer = await this.findOne(user, customerId);
    if (!customer) throw new NotFoundException('Customer not found');

    const customerGroup = await this.resolveCustomerNameGroup(user, customer);
    const logs = await this.prisma.activity_logs.findMany({
      where:
        user.role === Role.SUPER_ADMIN
          ? {}
          : { branch_id: requireUserBranchId(user) },
      select: {
        id: true,
        action: true,
        details: true,
        created_at: true,
        user_id: true,
        users: { select: { full_name: true, email: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    return logs
      .map((log) => {
        const parsedDetails = this.parseLogDetails(log.details);
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
          actorName:
            (log.users
              ? this.encryption.decryptUsersJoin(log.users)?.full_name
              : undefined) ||
            log.users?.email ||
            'System',
          userId: log.user_id || null,
        };
      })
      .filter(Boolean);
  }

  async addCustomerNote(
    user: UserWithBranch & { id: string },
    customerId: string,
    title?: string,
    note?: string,
  ) {
    const customer = await this.findOne(user, customerId);
    if (!customer) throw new NotFoundException('Customer not found');

    const trimmedNote = note?.trim() ?? '';
    if (!trimmedNote) throw new BadRequestException('Note is required');

    await this.prisma.activity_logs.create({
      data: {
        user_id: user.id,
        branch_id: customer.branch_id || null,
        action: 'CUSTOMER_NOTE_ADDED',
        details: JSON.stringify({
          customerId,
          title: title?.trim() || 'Manual Note',
          note: trimmedNote,
        }),
      },
    });

    return { message: 'Note saved successfully' };
  }

  async update(
    user: AuthenticatedUserProfile,
    id: string,
    updateDto: UpdateCustomerDto,
  ) {
    const existing = await this.findOne(user, id);
    if (!existing) throw new NotFoundException('Customer not found');

    if (user.role === Role.EMPLOYEE) {
      throw new ForbiddenException('Employees must request customer edits');
    }

    const requestingEmployeeId =
      updateDto.requestingEmployeeId?.trim() || undefined;
    const logId = updateDto.logId?.trim() || undefined;
    const allowedPayload = Object.fromEntries(
      Object.entries({
        full_name: updateDto.full_name?.trim(),
        contact_number: updateDto.contact_number?.trim(),
        email: updateDto.email?.trim().toLowerCase(),
        address: updateDto.address?.trim(),
        barangay: updateDto.barangay?.trim(),
        city: updateDto.city?.trim(),
        region: updateDto.region?.trim(),
        id_presented: updateDto.id_presented?.trim(),
      }).filter(([, value]) => value !== undefined),
    ) as Prisma.customersUncheckedUpdateInput;

    const forWrite = { ...allowedPayload } as Record<string, unknown>;
    this.encryption.applyCustomerFieldsForWrite(forWrite);

    await this.prisma.customers.update({
      where: { id },
      data: forWrite,
    });

    const trackedFields = [
      'full_name',
      'contact_number',
      'email',
      'address',
      'barangay',
      'city',
      'region',
      'id_presented',
    ] as const;
    const changedFields: Record<
      string,
      { from: string | null; to: string | null }
    > = {};

    for (const field of trackedFields) {
      const newVal = allowedPayload[field] as string | undefined;
      if (newVal === undefined) continue;
      const oldVal = (existing as Record<string, unknown>)[field] as
        | string
        | null;
      if (String(newVal) !== String(oldVal ?? '')) {
        changedFields[field] = { from: oldVal ?? null, to: newVal };
      }
    }

    await this.writeCustomerEditProcessedLog(
      user,
      existing,
      changedFields,
      logId,
    );

    if (requestingEmployeeId) {
      await this.notifyEmployeeOfProcessedEdit(
        requestingEmployeeId,
        id,
        existing.full_name,
        changedFields,
        Boolean(logId),
      );
    }

    return { message: 'Customer updated successfully' };
  }

  async requestEdit(
    user: AuthenticatedUserProfile,
    id: string,
    notes: string,
    field?: string,
    mode?: string,
  ) {
    const customer = await this.findOne(user, id);
    if (!customer) throw new NotFoundException('Customer not found');

    const trimmed = notes?.trim();
    if (!trimmed)
      throw new BadRequestException('Edit request notes are required');

    const branchName = user.branchName ?? 'Unknown Branch';
    const actorLabel = `${user.fullName ?? user.email} (Employee)`;

    const requestLog = await this.prisma.activity_logs.create({
      data: {
        user_id: user.id,
        branch_id: customer.branch_id || null,
        action: 'CUSTOMER_EDIT_REQUESTED',
        details: JSON.stringify({
          customerId: id,
          customerName: customer.full_name,
          notes: trimmed,
          field: field?.trim() || null,
          mode: mode?.trim() || 'freeform',
          branchName,
          actorLabel,
        }),
      },
      select: { id: true },
    });

    const branchId = user.branchId || customer.branch_id;
    if (branchId) {
      const admins = await this.prisma.users.findMany({
        where: { branch_id: branchId, role: 'admin', account_status: 'active' },
        select: { id: true },
      });

      await Promise.all(
        admins.map((admin) =>
          this.notificationsService.create({
            title: 'Customer Edit Request',
            subtitle: `${actorLabel} requested an edit for ${customer.full_name}`,
            category: 'Requests',
            user_id: admin.id,
            customer_id: id,
            log_id: requestLog.id,
          }),
        ),
      );
    }

    return { message: 'Edit request submitted successfully' };
  }

  async cancelRequestEdit(
    user: AuthenticatedUserProfile,
    id: string,
    logId: string,
  ) {
    const customer = await this.findOne(user, id);
    if (!customer) throw new NotFoundException('Customer not found');

    const log = await this.prisma.activity_logs.findFirst({
      where: {
        id: logId,
        user_id: user.id,
        action: 'CUSTOMER_EDIT_REQUESTED',
        ...(user.role === Role.SUPER_ADMIN
          ? {}
          : { branch_id: requireUserBranchId(user) }),
      },
      select: { id: true },
    });

    if (!log) throw new NotFoundException('Edit request not found');

    await this.prisma.$transaction([
      this.prisma.notifications.deleteMany({
        where: { category: 'Requests', log_id: logId },
      }),
      this.prisma.activity_logs.delete({ where: { id: logId } }),
    ]);

    return { message: 'Edit request canceled successfully' };
  }

  async mergeDuplicateCustomers(
    user: UserWithBranch & { id: string },
    branchId?: string,
  ) {
    const targetBranchId = this.resolveMergeBranchId(user, branchId);
    const customers = await this.prisma.customers.findMany({
      where: { branch_id: targetBranchId, deleted_at: null },
      select: { id: true, full_name: true, branch_id: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    const groupedCustomers = new Map<string, CustomerMergeCandidate[]>();
    for (const customer of customers) {
      const normalizedName = normalizeCustomerFullName(customer.full_name);
      const group = groupedCustomers.get(normalizedName) || [];
      group.push(customer);
      groupedCustomers.set(normalizedName, group);
    }

    const activityLogs = await this.prisma.activity_logs.findMany({
      where: { branch_id: targetBranchId },
      select: { id: true, details: true },
      orderBy: { created_at: 'asc' },
    });

    const mergeSummaries: Array<{
      canonicalCustomerId: string;
      canonicalCustomerName: string;
      mergedCustomerIds: string[];
      mergedCount: number;
      pawnedItemsReassigned: number;
      activityLogsUpdated: number;
    }> = [];

    for (const [normalizedName, group] of groupedCustomers.entries()) {
      if (group.length <= 1) continue;

      const canonicalCustomer = group[0];
      const duplicateIds = group.slice(1).map((customer) => customer.id);
      const duplicateIdSet = new Set(duplicateIds);

      const pawnedUpdate = await this.prisma.pawned_items.updateMany({
        where: { customer_id: { in: duplicateIds } },
        data: { customer_id: canonicalCustomer.id },
      });

      let activityLogsUpdated = 0;
      for (const log of activityLogs) {
        const parsedDetails = this.parseLogDetails(log.details);
        const detailsCustomerId =
          typeof parsedDetails.customerId === 'string'
            ? parsedDetails.customerId
            : typeof parsedDetails.customer_id === 'string'
              ? parsedDetails.customer_id
              : null;

        if (!detailsCustomerId || !duplicateIdSet.has(detailsCustomerId))
          continue;

        await this.prisma.activity_logs.update({
          where: { id: log.id },
          data: {
            details: JSON.stringify({
              ...parsedDetails,
              customerId: canonicalCustomer.id,
              customer_id: canonicalCustomer.id,
            }),
          },
        });
        activityLogsUpdated += 1;
      }

      await this.prisma.customers.updateMany({
        where: { id: { in: duplicateIds }, branch_id: targetBranchId },
        data: { deleted_at: new Date() },
      });

      mergeSummaries.push({
        canonicalCustomerId: canonicalCustomer.id,
        canonicalCustomerName: canonicalCustomer.full_name,
        mergedCustomerIds: duplicateIds,
        mergedCount: duplicateIds.length,
        pawnedItemsReassigned: pawnedUpdate.count,
        activityLogsUpdated,
      });

      await this.prisma.activity_logs.create({
        data: {
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
        },
      });
    }

    return {
      branchId: targetBranchId,
      mergedGroups: mergeSummaries.length,
      mergeSummaries,
    };
  }

  private parseLogDetails(details: string | null): Record<string, unknown> {
    if (!details) return {};
    try {
      return JSON.parse(details) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async writeCustomerEditProcessedLog(
    user: AuthenticatedUserProfile,
    customer: ProcessedCustomerLogTarget,
    changedFields: Record<string, { from: string | null; to: string | null }>,
    logId?: string,
  ) {
    const actorLabel = `${user.fullName ?? user.email} (Admin)`;
    const reviewedField = Object.keys(changedFields)[0] ?? null;
    const details = {
      customerId: customer.id,
      customerName: customer.full_name,
      changedFields,
      actorName: user.fullName ?? user.email,
      actorRole: 'Admin',
      actorLabel,
      branchName: user.branchName ?? customer.branch_name ?? 'Unknown Branch',
      reviewedField,
      oldValue: reviewedField
        ? (changedFields[reviewedField]?.from ?? null)
        : null,
      newValue: reviewedField
        ? (changedFields[reviewedField]?.to ?? null)
        : null,
      processedAt: new Date().toISOString(),
      adminId: user.id,
    };

    try {
      if (logId) {
        const updated = await this.prisma.activity_logs.updateMany({
          where: { id: logId, action: 'CUSTOMER_EDIT_REQUESTED' },
          data: {
            action: 'CUSTOMER_EDIT_PROCESSED',
            details: JSON.stringify(details),
          },
        });
        if (updated.count > 0) return;
      }

      await this.prisma.activity_logs.create({
        data: {
          user_id: user.id,
          branch_id: user.branchId || customer.branch_id || null,
          action: 'CUSTOMER_EDIT_PROCESSED',
          details: JSON.stringify(details),
        },
      });
    } catch (error) {
      this.logger.error(
        'Failed to write CUSTOMER_EDIT_PROCESSED log',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async notifyEmployeeOfProcessedEdit(
    employeeId: string,
    customerId: string,
    customerName: string,
    changedFields: Record<string, { from: string | null; to: string | null }>,
    hasLogId: boolean,
  ) {
    try {
      const reviewedField = Object.keys(changedFields)[0] ?? 'profile';
      const fieldLabelMap: Record<string, string> = {
        full_name: 'Full Name',
        contact_number: 'Contact Number',
        address: 'Address',
        email: 'Email Address',
        barangay: 'Barangay',
        city: 'City',
        region: 'Region',
        id_presented: 'ID Presented',
      };

      await this.notificationsService.create({
        title: hasLogId ? 'Edit Approved' : 'Edit Request Processed',
        subtitle: `Customer ${fieldLabelMap[reviewedField] ?? reviewedField} was updated for ${customerName}`,
        category: 'Requests',
        user_id: employeeId,
        customer_id: customerId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to create employee notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
