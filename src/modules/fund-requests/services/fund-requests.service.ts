import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../common/enums';
import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import {
  assertResourceBranch,
  effectiveBranchIdForQuery,
  requireUserBranchId,
  superAdminBranchNameFilter,
} from '../../../common/utils/branch-scope.util';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { ConfirmFundRequestDto } from '../dto/confirm-fund-request.dto';
import { CreateDirectTransferDto } from '../dto/create-direct-transfer.dto';
import { CreateFundRequestDto } from '../dto/create-fund-request.dto';
import { ListFundRequestsDto } from '../dto/list-fund-requests.dto';
import {
  FundRequestReviewDecision,
  ReviewFundRequestDto,
} from '../dto/review-fund-request.dto';
import { TransferFundRequestDto } from '../dto/transfer-fund-request.dto';

interface BranchRow {
  id: string;
  name: string;
  branch_code: string | null;
  location: string | null;
  status?: string | null;
}

interface UserSummaryRow {
  id: string;
  full_name: string | null;
  email: string | null;
  role?: string | null;
  branch_id?: string | null;
}

interface FundRequestRow {
  id: string;
  request_no: string;
  branch_id: string;
  requested_by_user_id: string;
  amount_requested: number | string;
  purpose: string;
  notes: string | null;
  status: string;
  approved_amount: number | string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  amount_transferred: number | string | null;
  transferred_by_user_id: string | null;
  transferred_at: string | null;
  transfer_reference: string | null;
  transfer_notes: string | null;
  flow_type: string | null;
  receiver_user_id: string | null;
  source_branch_id: string | null;
  receiver_role: string | null;
  confirmed_received_amount: number | string | null;
  confirmation_note: string | null;
  transfer_reference_no: string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  confirmation_notes: string | null;
  related_transaction_id: string | null;
  created_at: string;
  updated_at: string;
  branches?: BranchRow | BranchRow[] | null;
  requested_by?: UserSummaryRow | UserSummaryRow[] | null;
  reviewed_by?: UserSummaryRow | UserSummaryRow[] | null;
  transferred_by?: UserSummaryRow | UserSummaryRow[] | null;
  confirmed_by?: UserSummaryRow | UserSummaryRow[] | null;
}

const FUND_REQUEST_SELECT = `
  id,
  request_no,
  branch_id,
  requested_by_user_id,
  amount_requested,
  purpose,
  notes,
  status,
  approved_amount,
  reviewed_by_user_id,
  reviewed_at,
  review_notes,
  amount_transferred,
  transferred_by_user_id,
  transferred_at,
  transfer_reference,
  transfer_notes,
  flow_type,
  receiver_user_id,
  source_branch_id,
  receiver_role,
  confirmed_received_amount,
  confirmation_note,
  transfer_reference_no,
  confirmed_at,
  confirmation_notes,
  related_transaction_id,
  created_at,
  updated_at,
  branches:branches!branch_id(id, name, branch_code, location),
  requested_by:requested_by_user_id(id, full_name, email),
  reviewed_by:reviewed_by_user_id(id, full_name, email),
  transferred_by:transferred_by_user_id(id, full_name, email),
  confirmed_by_user_id
`;

@Injectable()
export class FundRequestsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly activityLogsService: ActivityLogsService,
  ) {}

  private toDatePart(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private toTimePart(date: Date): string {
    return date.toISOString().split('T')[1]?.slice(0, 8) ?? '00:00:00';
  }

  private compactText(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeMoney(value: number | string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException('Amount must be greater than zero');
    }
    return Number(parsed.toFixed(2));
  }

  private toMoneyOrNull(
    value: number | string | null | undefined,
  ): number | null {
    if (value == null) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
  }

  private isActiveBranch(status: string | null | undefined): boolean {
    return status?.trim().toLowerCase() === 'active';
  }

  private toReceiverRole(role: Role): 'admin' | 'employee' {
    return role === Role.ADMIN ? 'admin' : 'employee';
  }

  private isPendingConfirmationRow(
    row: Pick<
      FundRequestRow,
      'status' | 'transferred_at' | 'amount_transferred' | 'confirmed_at'
    >,
  ): boolean {
    if (row.status === 'pending_confirmation') {
      return true;
    }
    // Backward compatibility: some DBs still reject pending_confirmation in status check.
    return (
      row.status === 'approved' &&
      !!row.transferred_at &&
      this.toMoneyOrNull(row.amount_transferred) != null &&
      !row.confirmed_at
    );
  }

  private isStatusConstraintError(errorMessage: string): boolean {
    return (
      errorMessage.includes('fund_requests_status_check') &&
      errorMessage.includes('violates check constraint')
    );
  }

  private isTransactionsPurposeConstraintError(errorMessage: string): boolean {
    return (
      errorMessage.includes('transactions_purpose_check') &&
      errorMessage.includes('violates check constraint')
    );
  }

  private async getBranchById(branchId: string): Promise<BranchRow> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('id, name, branch_code, location, status')
      .eq('id', branchId)
      .maybeSingle<BranchRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new NotFoundException('Branch not found');
    }

    return data;
  }

  private async getUserById(userId: string): Promise<UserSummaryRow> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('users')
      .select('id, full_name, email, role, branch_id')
      .eq('id', userId)
      .maybeSingle<UserSummaryRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    if (!data) {
      throw new NotFoundException('Receiver user not found');
    }
    return data;
  }

  private async getLatestBranchBalance(branchId: string): Promise<number> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('daily_balances')
      .select('ending_balance')
      .eq('branch_id', branchId)
      .order('record_date', { ascending: false })
      .limit(1)
      .maybeSingle<{ ending_balance: number | string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return Number(data?.ending_balance ?? 0);
  }

  private async getNextCode(
    table: 'fund_requests' | 'transactions',
    column: 'request_no' | 'transaction_no',
    prefix: string,
  ): Promise<string> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from(table)
      .select(column)
      .ilike(column, `${prefix}%`)
      .order(column, { ascending: false })
      .limit(1);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const latestValue = data?.[0]?.[column];
    const latestSeq = latestValue
      ? Number(String(latestValue).split('-').pop())
      : 0;
    const nextSeq = Number.isFinite(latestSeq) ? latestSeq + 1 : 1;

    return `${prefix}${String(nextSeq).padStart(3, '0')}`;
  }

  private async getFundRequestById(id: string): Promise<FundRequestRow> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .select(FUND_REQUEST_SELECT)
      .eq('id', id)
      .maybeSingle<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new NotFoundException('Fund request not found');
    }

    return data;
  }

  private async resolveSuperAdminBranchIdsByName(
    branchQuery?: string,
  ): Promise<string[] | null> {
    const branchName = superAdminBranchNameFilter(
      { role: Role.SUPER_ADMIN, branchId: null },
      branchQuery,
    );

    if (!branchName) {
      return null;
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('id')
      .ilike('name', `%${branchName}%`);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (data ?? []).map((row: { id: string }) => row.id);
  }

  private mapFundRequest(row: FundRequestRow) {
    const branch = Array.isArray(row.branches)
      ? (row.branches[0] ?? null)
      : (row.branches ?? null);
    const requestedBy = Array.isArray(row.requested_by)
      ? (row.requested_by[0] ?? null)
      : (row.requested_by ?? null);
    const reviewedBy = Array.isArray(row.reviewed_by)
      ? (row.reviewed_by[0] ?? null)
      : (row.reviewed_by ?? null);
    const transferredBy = Array.isArray(row.transferred_by)
      ? (row.transferred_by[0] ?? null)
      : (row.transferred_by ?? null);
    const confirmedBy = Array.isArray(row.confirmed_by)
      ? (row.confirmed_by[0] ?? null)
      : (row.confirmed_by ?? null);

    return {
      id: row.id,
      requestNo: row.request_no,
      branchId: row.branch_id,
      requestedByUserId: row.requested_by_user_id,
      amountRequested: this.toMoneyOrNull(row.amount_requested) ?? 0,
      purpose: row.purpose,
      notes: row.notes,
      status: this.isPendingConfirmationRow(row)
        ? 'pending_confirmation'
        : row.status,
      approvedAmount: this.toMoneyOrNull(row.approved_amount),
      reviewedAt: row.reviewed_at,
      reviewNotes: row.review_notes,
      amountTransferred: this.toMoneyOrNull(row.amount_transferred),
      transferredAt: row.transferred_at,
      transferReference: row.transfer_reference,
      transferNotes: row.transfer_notes,
      flowType: row.flow_type ?? 'request_based',
      receiverUserId: row.receiver_user_id,
      sourceBranchId: row.source_branch_id,
      receiverRole: row.receiver_role,
      confirmedReceivedAmount: this.toMoneyOrNull(
        row.confirmed_received_amount,
      ),
      confirmationNote: row.confirmation_note,
      transferReferenceNo: row.transfer_reference_no,
      confirmedAt: row.confirmed_at,
      confirmationNotes: row.confirmation_notes,
      relatedTransactionId: row.related_transaction_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      branch: branch
        ? {
            id: branch.id,
            name: branch.name,
            branchCode: branch.branch_code,
            location: branch.location,
          }
        : null,
      requestedBy: requestedBy
        ? {
            id: requestedBy.id,
            fullName: requestedBy.full_name,
            email: requestedBy.email,
          }
        : null,
      reviewedBy: reviewedBy
        ? {
            id: reviewedBy.id,
            fullName: reviewedBy.full_name,
            email: reviewedBy.email,
          }
        : null,
      transferredBy: transferredBy
        ? {
            id: transferredBy.id,
            fullName: transferredBy.full_name,
            email: transferredBy.email,
          }
        : null,
      confirmedBy: confirmedBy
        ? {
            id: confirmedBy.id,
            fullName: confirmedBy.full_name,
            email: confirmedBy.email,
          }
        : null,
    };
  }

  private async adjustDailyBalance(
    branchId: string,
    delta: number,
  ): Promise<void> {
    const amount = Number(delta.toFixed(2));
    const today = this.toDatePart(new Date());
    const client = this.supabaseService.getClient();

    const { data: existing, error: existingError } = await client
      .from('daily_balances')
      .select('id, ending_balance')
      .eq('branch_id', branchId)
      .eq('record_date', today)
      .maybeSingle<{ id: string; ending_balance: number | string }>();

    if (existingError) {
      throw new InternalServerErrorException(existingError.message);
    }

    if (existing) {
      const endingBalance = Number(existing.ending_balance ?? 0);
      const { error: updateError } = await client
        .from('daily_balances')
        .update({ ending_balance: Number((endingBalance + amount).toFixed(2)) })
        .eq('id', existing.id);

      if (updateError) {
        throw new InternalServerErrorException(updateError.message);
      }

      return;
    }

    const { data: lastBalance, error: lastBalanceError } = await client
      .from('daily_balances')
      .select('ending_balance')
      .eq('branch_id', branchId)
      .order('record_date', { ascending: false })
      .limit(1)
      .maybeSingle<{ ending_balance: number | string }>();

    if (lastBalanceError) {
      throw new InternalServerErrorException(lastBalanceError.message);
    }

    const startingBalance = Number(lastBalance?.ending_balance ?? 0);
    const { error: insertError } = await client.from('daily_balances').insert({
      branch_id: branchId,
      record_date: today,
      starting_balance: Number(startingBalance.toFixed(2)),
      ending_balance: Number((startingBalance + amount).toFixed(2)),
    });

    if (insertError) {
      throw new InternalServerErrorException(insertError.message);
    }
  }

  private async createTransferTransaction(params: {
    branch: BranchRow;
    request: FundRequestRow;
    amount: number;
    transferReference: string | null;
    transferNotes: string | null;
  }): Promise<{ id: string }> {
    const now = new Date();
    const prefix = `FT-${this.toDatePart(now).replace(/-/g, '')}-`;
    const transactionNo = await this.getNextCode(
      'transactions',
      'transaction_no',
      prefix,
    );
    const detailsParts = [
      `Fund transfer for ${params.request.request_no}`,
      params.request.purpose ? `Purpose: ${params.request.purpose}` : '',
      params.transferReference ? `Reference: ${params.transferReference}` : '',
      params.transferNotes ? `Notes: ${params.transferNotes}` : '',
    ].filter(Boolean);

    const { data, error } = await this.supabaseService
      .getClient()
      .from('transactions')
      .insert({
        transaction_no: transactionNo,
        branch_id: params.branch.id,
        branch: params.branch.name,
        purpose: 'Cash Transfer',
        transaction_date: this.toDatePart(now),
        transaction_time: this.toTimePart(now),
        cash_in: params.amount,
        cash_out: 0,
        return_amount: 0,
        unit: 'fund_transfer',
        unit_code: params.request.request_no,
        pawn_amount: 0,
        storage_fee: 0,
        details: detailsParts.join(' | '),
      })
      .select('id')
      .single<{ id: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  private async createTransferTransactions(params: {
    request: FundRequestRow;
    destinationBranch: BranchRow;
    amount: number;
    transferReference: string | null;
    transferNotes: string | null;
    sourceBranch?: BranchRow | null;
  }): Promise<{
    inboundTransactionId: string;
    outboundTransactionId: string | null;
  }> {
    let outboundId: string | null = null;
    if (params.sourceBranch) {
      const now = new Date();
      const prefix = `FT-${this.toDatePart(now).replace(/-/g, '')}-`;
      const transactionNo = await this.getNextCode(
        'transactions',
        'transaction_no',
        prefix,
      );
      const { data, error } = await this.supabaseService
        .getClient()
        .from('transactions')
        .insert({
          transaction_no: transactionNo,
          branch_id: params.sourceBranch.id,
          branch: params.sourceBranch.name,
          purpose: 'Cash Transfer',
          transaction_date: this.toDatePart(now),
          transaction_time: this.toTimePart(now),
          cash_in: 0,
          cash_out: params.amount,
          return_amount: 0,
          unit: 'fund_transfer_out',
          unit_code: params.request.request_no,
          pawn_amount: 0,
          storage_fee: 0,
          details: `Transfer out to ${params.destinationBranch.name} | Ref: ${params.transferReference ?? 'N/A'} | Notes: ${params.transferNotes ?? '-'}`,
        })
        .select('id')
        .single<{ id: string }>();

      if (error) {
        throw new InternalServerErrorException(error.message);
      }
      outboundId = data.id;
    }

    const inbound = await this.createTransferTransaction({
      branch: params.destinationBranch,
      request: params.request,
      amount: params.amount,
      transferReference: params.transferReference,
      transferNotes: params.transferNotes,
    });

    return {
      inboundTransactionId: inbound.id,
      outboundTransactionId: outboundId,
    };
  }

  private async writeFundLog(params: {
    user: AuthenticatedUserProfile;
    branchId: string | null;
    action: string;
    details: Record<string, unknown>;
  }) {
    await this.activityLogsService.createLog({
      userId: params.user.id,
      branchId: params.branchId,
      action: params.action,
      details: params.details,
    });
  }

  private async resolveReceiver(dto: {
    receiverUserId?: string;
    receiverRole?: 'admin' | 'employee';
    branchId: string;
  }): Promise<{ receiverUserId: string | null; receiverRole: string | null }> {
    if (!dto.receiverUserId && !dto.receiverRole) {
      return { receiverUserId: null, receiverRole: null };
    }

    if (dto.receiverUserId) {
      const receiver = await this.getUserById(dto.receiverUserId);
      if (receiver.branch_id !== dto.branchId) {
        throw new BadRequestException(
          'Receiver user must belong to the same destination branch',
        );
      }
      const role = (receiver.role ?? '').toLowerCase();
      if (role !== 'admin' && role !== 'employee') {
        throw new BadRequestException(
          'Receiver user must be either admin or employee',
        );
      }
      return {
        receiverUserId: receiver.id,
        receiverRole: role,
      };
    }

    return {
      receiverUserId: null,
      receiverRole: dto.receiverRole ?? null,
    };
  }

  async create(user: AuthenticatedUserProfile, dto: CreateFundRequestDto) {
    if (user.role !== Role.ADMIN && user.role !== Role.EMPLOYEE) {
      throw new ForbiddenException(
        'Only branch users can create fund requests',
      );
    }

    const branchId = requireUserBranchId(user);
    const branch = await this.getBranchById(branchId);
    if (!this.isActiveBranch(branch.status)) {
      throw new BadRequestException(
        'Inactive branches cannot submit fund requests',
      );
    }

    const receiver = await this.resolveReceiver({
      branchId: branch.id,
      receiverRole: dto.receiverRole,
      receiverUserId: dto.receiverUserId,
    });

    const now = new Date();
    const requestNo = await this.getNextCode(
      'fund_requests',
      'request_no',
      `FR-${this.toDatePart(now).replace(/-/g, '')}-`,
    );

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .insert({
        request_no: requestNo,
        branch_id: branch.id,
        requested_by_user_id: user.id,
        amount_requested: this.normalizeMoney(dto.amountRequested),
        purpose: dto.purpose.trim(),
        notes: this.compactText(dto.notes),
        flow_type: 'request_based',
        receiver_user_id: receiver.receiverUserId,
        receiver_role: receiver.receiverRole,
        status: 'pending',
      })
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const mapped = this.mapFundRequest(data);
    await this.writeFundLog({
      user,
      branchId: branch.id,
      action: 'FUND_REQUEST_CREATED',
      details: {
        requestNo: mapped.requestNo,
        amountRequested: mapped.amountRequested,
        receiverRole: mapped.receiverRole,
        flowType: mapped.flowType,
      },
    });
    return mapped;
  }

  async createDirectTransfer(
    user: AuthenticatedUserProfile,
    dto: CreateDirectTransferDto,
  ) {
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only super admins can create direct transfers',
      );
    }

    const destinationBranch = await this.getBranchById(dto.toBranchId);
    if (!this.isActiveBranch(destinationBranch.status)) {
      throw new BadRequestException(
        'Cannot transfer funds to an inactive branch',
      );
    }

    const sourceBranch = dto.fromBranchId
      ? await this.getBranchById(dto.fromBranchId)
      : null;
    if (sourceBranch && sourceBranch.id === destinationBranch.id) {
      throw new BadRequestException(
        'Source and destination branch cannot be the same',
      );
    }

    const receiver = await this.resolveReceiver({
      branchId: destinationBranch.id,
      receiverRole: dto.receiverRole,
      receiverUserId: dto.receiverUserId,
    });

    const now = new Date();
    const requestNo = await this.getNextCode(
      'fund_requests',
      'request_no',
      `DF-${this.toDatePart(now).replace(/-/g, '')}-`,
    );
    const amount = this.normalizeMoney(dto.amount);
    if (sourceBranch) {
      const sourceBalance = await this.getLatestBranchBalance(sourceBranch.id);
      if (sourceBalance < amount) {
        throw new BadRequestException(
          `Source branch has insufficient cash on hand. Available: ${sourceBalance.toFixed(2)}`,
        );
      }
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .insert({
        request_no: requestNo,
        branch_id: destinationBranch.id,
        requested_by_user_id: user.id,
        amount_requested: amount,
        purpose: this.compactText(dto.purpose) ?? 'Direct cash transfer',
        notes: this.compactText(dto.notes),
        flow_type: 'direct_push',
        receiver_user_id: receiver.receiverUserId,
        source_branch_id: sourceBranch?.id ?? null,
        receiver_role: receiver.receiverRole,
        status: 'pending_confirmation',
        approved_amount: amount,
        reviewed_by_user_id: user.id,
        reviewed_at: now.toISOString(),
        amount_transferred: amount,
        transferred_by_user_id: user.id,
        transferred_at: now.toISOString(),
        transfer_reference: this.compactText(dto.transferReference),
        transfer_notes: this.compactText(dto.notes),
        transfer_reference_no: this.compactText(dto.transferReference),
      })
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    let createdData = data;
    if (error) {
      if (!this.isStatusConstraintError(error.message)) {
        throw new InternalServerErrorException(error.message);
      }
      const fallback = await this.supabaseService
        .getClient()
        .from('fund_requests')
        .insert({
          request_no: requestNo,
          branch_id: destinationBranch.id,
          requested_by_user_id: user.id,
          amount_requested: amount,
          purpose: this.compactText(dto.purpose) ?? 'Direct cash transfer',
          notes: this.compactText(dto.notes),
          flow_type: 'direct_push',
          receiver_user_id: receiver.receiverUserId,
          source_branch_id: sourceBranch?.id ?? null,
          receiver_role: receiver.receiverRole,
          // Legacy DB compatibility: represent "awaiting confirmation" while status check is outdated.
          status: 'approved',
          approved_amount: amount,
          reviewed_by_user_id: user.id,
          reviewed_at: now.toISOString(),
          amount_transferred: amount,
          transferred_by_user_id: user.id,
          transferred_at: now.toISOString(),
          transfer_reference: this.compactText(dto.transferReference),
          transfer_notes: this.compactText(dto.notes),
          transfer_reference_no: this.compactText(dto.transferReference),
        })
        .select(FUND_REQUEST_SELECT)
        .single<FundRequestRow>();
      if (fallback.error) {
        throw new InternalServerErrorException(fallback.error.message);
      }
      createdData = fallback.data;
    }

    if (!createdData) {
      throw new InternalServerErrorException('Failed to create fund transfer');
    }
    const mapped = this.mapFundRequest(createdData);
    await this.writeFundLog({
      user,
      branchId: destinationBranch.id,
      action: 'FUND_TRANSFER_RELEASED',
      details: {
        requestNo: mapped.requestNo,
        flowType: mapped.flowType,
        amountTransferred: mapped.amountTransferred,
        sourceBranchId: sourceBranch?.id ?? null,
        destinationBranchId: destinationBranch.id,
      },
    });
    return mapped;
  }

  async findAll(user: AuthenticatedUserProfile, queryDto: ListFundRequestsDto) {
    const client = this.supabaseService.getClient();
    let query = client
      .from('fund_requests')
      .select(FUND_REQUEST_SELECT)
      .order('created_at', { ascending: false });

    const matchingBranchIds =
      user.role === Role.SUPER_ADMIN
        ? await this.resolveSuperAdminBranchIdsByName(queryDto.branch)
        : null;
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, queryDto.branch)
        : requireUserBranchId(user);

    if (branchId) {
      query = query.eq('branch_id', branchId);
    } else if (matchingBranchIds) {
      if (matchingBranchIds.length === 0) {
        return [];
      }
      query = query.in('branch_id', matchingBranchIds);
    }

    if (queryDto.status) {
      query = query.eq('status', queryDto.status);
    }

    const search = queryDto.search?.trim();
    if (search) {
      query = query.or(
        `request_no.ilike.%${search}%,purpose.ilike.%${search}%`,
      );
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (data ?? []).map((row) =>
      this.mapFundRequest(row as FundRequestRow),
    );
  }

  async findOne(user: AuthenticatedUserProfile, id: string) {
    const fundRequest = await this.getFundRequestById(id);
    assertResourceBranch(user, fundRequest.branch_id);
    return this.mapFundRequest(fundRequest);
  }

  async review(
    user: AuthenticatedUserProfile,
    id: string,
    dto: ReviewFundRequestDto,
  ) {
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only super admins can review fund requests',
      );
    }

    const existing = await this.getFundRequestById(id);
    if (existing.status !== 'pending') {
      throw new BadRequestException(
        'Only pending fund requests can be reviewed',
      );
    }

    const approvedAmount =
      dto.decision === FundRequestReviewDecision.APPROVED
        ? this.normalizeMoney(dto.approvedAmount ?? existing.amount_requested)
        : null;

    if (
      approvedAmount != null &&
      approvedAmount > this.normalizeMoney(existing.amount_requested)
    ) {
      throw new BadRequestException(
        'Approved amount cannot exceed the requested amount',
      );
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({
        status:
          dto.decision === FundRequestReviewDecision.APPROVED
            ? 'approved'
            : 'rejected',
        approved_amount: approvedAmount,
        reviewed_by_user_id: user.id,
        reviewed_at: new Date().toISOString(),
        review_notes: this.compactText(dto.reviewNotes),
      })
      .eq('id', id)
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const mapped = this.mapFundRequest(data);
    await this.writeFundLog({
      user,
      branchId: mapped.branchId,
      action: 'FUND_REQUEST_REVIEWED',
      details: {
        requestNo: mapped.requestNo,
        decision: dto.decision,
        approvedAmount: mapped.approvedAmount,
      },
    });
    return mapped;
  }

  async transfer(
    user: AuthenticatedUserProfile,
    id: string,
    dto: TransferFundRequestDto,
  ) {
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can transfer funds');
    }

    const existing = await this.getFundRequestById(id);
    if (existing.status === 'rejected' || existing.status === 'cancelled') {
      throw new BadRequestException(
        'Rejected or cancelled fund requests cannot be transferred',
      );
    }
    if (existing.status === 'pending_confirmation') {
      throw new BadRequestException(
        'This fund request is already awaiting branch confirmation',
      );
    }
    if (existing.status === 'transferred') {
      throw new BadRequestException(
        'This fund request has already been transferred',
      );
    }
    if (existing.status !== 'approved') {
      throw new BadRequestException(
        'Only approved fund requests can be sent for branch confirmation',
      );
    }

    const branch = Array.isArray(existing.branches)
      ? (existing.branches[0] ?? null)
      : (existing.branches ?? null);
    const resolvedBranch =
      branch ?? (await this.getBranchById(existing.branch_id));
    const fallbackAmount =
      this.toMoneyOrNull(existing.approved_amount) ??
      this.toMoneyOrNull(existing.amount_requested) ??
      0;
    const transferAmount = this.normalizeMoney(dto.amount ?? fallbackAmount);
    const requestedAmount = this.normalizeMoney(existing.amount_requested);

    if (transferAmount > requestedAmount) {
      throw new BadRequestException(
        'Transferred amount cannot exceed the requested amount',
      );
    }

    const receiver = await this.resolveReceiver({
      branchId: existing.branch_id,
      receiverRole: dto.receiverRole,
      receiverUserId: dto.receiverUserId,
    });

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({
        status: 'pending_confirmation',
        approved_amount:
          this.toMoneyOrNull(existing.approved_amount) ?? transferAmount,
        reviewed_by_user_id: existing.reviewed_by_user_id ?? user.id,
        reviewed_at: existing.reviewed_at ?? new Date().toISOString(),
        review_notes: this.compactText(existing.review_notes),
        amount_transferred: transferAmount,
        transferred_by_user_id: user.id,
        transferred_at: new Date().toISOString(),
        transfer_reference: this.compactText(dto.transferReference),
        transfer_notes: this.compactText(dto.transferNotes),
        transfer_reference_no: this.compactText(dto.transferReference),
        receiver_user_id: receiver.receiverUserId,
        receiver_role: receiver.receiverRole,
      })
      .eq('id', id)
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    let updatedData = data;
    if (error) {
      if (!this.isStatusConstraintError(error.message)) {
        throw new InternalServerErrorException(error.message);
      }
      const fallback = await this.supabaseService
        .getClient()
        .from('fund_requests')
        .update({
          status: 'approved',
          approved_amount:
            this.toMoneyOrNull(existing.approved_amount) ?? transferAmount,
          reviewed_by_user_id: existing.reviewed_by_user_id ?? user.id,
          reviewed_at: existing.reviewed_at ?? new Date().toISOString(),
          review_notes: this.compactText(existing.review_notes),
          amount_transferred: transferAmount,
          transferred_by_user_id: user.id,
          transferred_at: new Date().toISOString(),
          transfer_reference: this.compactText(dto.transferReference),
          transfer_notes: this.compactText(dto.transferNotes),
          transfer_reference_no: this.compactText(dto.transferReference),
          receiver_user_id: receiver.receiverUserId,
          receiver_role: receiver.receiverRole,
        })
        .eq('id', id)
        .select(FUND_REQUEST_SELECT)
        .single<FundRequestRow>();
      if (fallback.error) {
        throw new InternalServerErrorException(fallback.error.message);
      }
      updatedData = fallback.data;
    }

    if (!updatedData) {
      throw new InternalServerErrorException('Failed to update fund transfer');
    }
    const mapped = this.mapFundRequest(updatedData);
    await this.writeFundLog({
      user,
      branchId: mapped.branchId,
      action: 'FUND_TRANSFER_RELEASED',
      details: {
        requestNo: mapped.requestNo,
        amountTransferred: mapped.amountTransferred,
        receiverRole: mapped.receiverRole,
      },
    });
    return mapped;
  }

  async confirm(
    user: AuthenticatedUserProfile,
    id: string,
    dto: ConfirmFundRequestDto,
  ) {
    if (user.role !== Role.ADMIN && user.role !== Role.EMPLOYEE) {
      throw new ForbiddenException(
        'Only branch admins or employees can confirm pending fund transfers',
      );
    }

    const existing = await this.getFundRequestById(id);
    assertResourceBranch(user, existing.branch_id);

    if (!this.isPendingConfirmationRow(existing)) {
      if (existing.receiver_user_id && existing.receiver_user_id !== user.id) {
        throw new ForbiddenException(
          'This transfer is assigned to another receiver',
        );
      }
      if (
        existing.receiver_role &&
        existing.receiver_role !== this.toReceiverRole(user.role)
      ) {
        throw new ForbiddenException(
          'Your role is not allowed to confirm this transfer',
        );
      }

      throw new BadRequestException(
        'Only pending confirmation requests can be confirmed',
      );
    }

    const branch = Array.isArray(existing.branches)
      ? (existing.branches[0] ?? null)
      : (existing.branches ?? null);
    const resolvedBranch =
      branch ?? (await this.getBranchById(existing.branch_id));
    const transferAmount =
      this.toMoneyOrNull(existing.amount_transferred) ??
      this.toMoneyOrNull(existing.approved_amount) ??
      this.toMoneyOrNull(existing.amount_requested);
    const confirmedAmount = this.normalizeMoney(
      dto.receivedAmount ?? transferAmount ?? 0,
    );

    let inboundTransactionId: string | null = null;
    let outboundTransactionId: string | null = null;
    const sourceBranch = existing.source_branch_id
      ? await this.getBranchById(existing.source_branch_id)
      : null;
    try {
      const transferTx = await this.createTransferTransactions({
        destinationBranch: resolvedBranch,
        request: existing,
        amount: confirmedAmount,
        transferReference:
          this.compactText(existing.transfer_reference_no) ??
          this.compactText(existing.transfer_reference),
        transferNotes:
          this.compactText(dto.confirmationNotes) ??
          this.compactText(existing.transfer_notes),
        sourceBranch,
      });
      inboundTransactionId = transferTx.inboundTransactionId;
      outboundTransactionId = transferTx.outboundTransactionId;
      await this.adjustDailyBalance(existing.branch_id, confirmedAmount);
      if (sourceBranch) {
        await this.adjustDailyBalance(sourceBranch.id, -confirmedAmount);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err ?? '');
      if (this.isTransactionsPurposeConstraintError(errorMessage)) {
        // Allow confirmation to proceed even if legacy transactions purpose
        // constraint rejects fund-transfer journal entries.
        await this.adjustDailyBalance(existing.branch_id, confirmedAmount);
        if (sourceBranch) {
          await this.adjustDailyBalance(sourceBranch.id, -confirmedAmount);
        }
      } else {
        if (inboundTransactionId) {
          await this.supabaseService
            .getClient()
            .from('transactions')
            .delete()
            .eq('id', inboundTransactionId);
        }
        if (outboundTransactionId) {
          await this.supabaseService
            .getClient()
            .from('transactions')
            .delete()
            .eq('id', outboundTransactionId);
        }
        throw err;
      }
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({
        status: 'transferred',
        confirmed_by_user_id: user.id,
        confirmed_at: new Date().toISOString(),
        confirmed_received_amount: confirmedAmount,
        confirmation_notes: this.compactText(dto.confirmationNotes),
        confirmation_note: this.compactText(dto.confirmationNotes),
        related_transaction_id: inboundTransactionId,
      })
      .eq('id', id)
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const mapped = this.mapFundRequest(data);
    await this.writeFundLog({
      user,
      branchId: mapped.branchId,
      action: 'FUND_TRANSFER_CONFIRMED',
      details: {
        requestNo: mapped.requestNo,
        confirmedReceivedAmount: mapped.confirmedReceivedAmount,
        confirmedByRole: user.role,
        relatedTransactionId: mapped.relatedTransactionId,
        sourceBranchId: mapped.sourceBranchId,
      },
    });
    await this.writeFundLog({
      user,
      branchId: mapped.branchId,
      action: 'BRANCH_CASH_ON_HAND_UPDATED',
      details: {
        requestNo: mapped.requestNo,
        delta: mapped.confirmedReceivedAmount,
      },
    });
    return mapped;
  }

  async cancel(user: AuthenticatedUserProfile, id: string) {
    if (user.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only branch admins can cancel fund requests',
      );
    }

    const existing = await this.getFundRequestById(id);
    assertResourceBranch(user, existing.branch_id);

    if (existing.status !== 'pending') {
      throw new BadRequestException(
        'Only pending fund requests can be cancelled',
      );
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return this.mapFundRequest(data);
  }
}
