import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../common/enums';
import {
  assertResourceBranch,
  effectiveBranchIdForQuery,
  requireUserBranchId,
  superAdminBranchNameFilter,
} from '../../../common/utils/branch-scope.util';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { ConfirmFundRequestDto } from '../dto/confirm-fund-request.dto';
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
  confirmed_by_user_id,
  confirmed_at,
  confirmation_notes,
  related_transaction_id,
  created_at,
  updated_at,
  branches(id, name, branch_code, location),
  requested_by:requested_by_user_id(id, full_name, email),
  reviewed_by:reviewed_by_user_id(id, full_name, email),
  transferred_by:transferred_by_user_id(id, full_name, email),
  confirmed_by:confirmed_by_user_id(id, full_name, email)
`;

@Injectable()
export class FundRequestsService {
  constructor(private readonly supabaseService: SupabaseService) {}

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
      status: row.status,
      approvedAmount: this.toMoneyOrNull(row.approved_amount),
      reviewedAt: row.reviewed_at,
      reviewNotes: row.review_notes,
      amountTransferred: this.toMoneyOrNull(row.amount_transferred),
      transferredAt: row.transferred_at,
      transferReference: row.transfer_reference,
      transferNotes: row.transfer_notes,
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
        purpose: 'Fund Transfer',
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

  async create(user: AuthenticatedUserProfile, dto: CreateFundRequestDto) {
    if (user.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only branch admins can create fund requests',
      );
    }

    const branchId = requireUserBranchId(user);
    const branch = await this.getBranchById(branchId);
    if (!this.isActiveBranch(branch.status)) {
      throw new BadRequestException(
        'Inactive branches cannot submit fund requests',
      );
    }

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
        status: 'pending',
      })
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return this.mapFundRequest(data);
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

    return this.mapFundRequest(data);
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
      })
      .eq('id', id)
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return this.mapFundRequest(data);
  }

  async confirm(
    user: AuthenticatedUserProfile,
    id: string,
    dto: ConfirmFundRequestDto,
  ) {
    if (user.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only branch admins can confirm pending fund transfers',
      );
    }

    const existing = await this.getFundRequestById(id);
    assertResourceBranch(user, existing.branch_id);

    if (existing.status !== 'pending_confirmation') {
      throw new BadRequestException(
        'Only pending confirmation requests can be confirmed',
      );
    }

    const branch = Array.isArray(existing.branches)
      ? (existing.branches[0] ?? null)
      : (existing.branches ?? null);
    const resolvedBranch =
      branch ?? (await this.getBranchById(existing.branch_id));
    const confirmedAmount =
      this.toMoneyOrNull(existing.amount_transferred) ??
      this.toMoneyOrNull(existing.approved_amount) ??
      this.toMoneyOrNull(existing.amount_requested);

    if (!confirmedAmount || confirmedAmount <= 0) {
      throw new BadRequestException(
        'Confirmed transfer amount is missing or invalid',
      );
    }

    const transaction = await this.createTransferTransaction({
      branch: resolvedBranch,
      request: existing,
      amount: confirmedAmount,
      transferReference: this.compactText(existing.transfer_reference),
      transferNotes:
        this.compactText(dto.confirmationNotes) ??
        this.compactText(existing.transfer_notes),
    });

    await this.adjustDailyBalance(existing.branch_id, confirmedAmount);

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({
        status: 'transferred',
        confirmed_by_user_id: user.id,
        confirmed_at: new Date().toISOString(),
        confirmation_notes: this.compactText(dto.confirmationNotes),
        related_transaction_id: transaction.id,
      })
      .eq('id', id)
      .select(FUND_REQUEST_SELECT)
      .single<FundRequestRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return this.mapFundRequest(data);
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
