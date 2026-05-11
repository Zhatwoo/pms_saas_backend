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
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { FinanceDailyBalanceService } from '../../branch-finance/services/finance-daily-balance.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { ConfirmFundRequestDto } from '../dto/confirm-fund-request.dto';
import { CreateDirectTransferDto } from '../dto/create-direct-transfer.dto';
import { CreateFundRequestDto } from '../dto/create-fund-request.dto';
import { ListFundRequestsDto } from '../dto/list-fund-requests.dto';
import {
  FundRequestReviewDecision,
  ReviewFundRequestDto,
} from '../dto/review-fund-request.dto';
import { SourceConfirmFundRequestDto } from '../dto/source-confirm-fund-request.dto';
import { TransferFundRequestDto } from '../dto/transfer-fund-request.dto';
import { UploadFundTransferProofDto } from '../dto/upload-fund-transfer-proof.dto';

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
  transfer_mode: string | null;
  flow_type: string | null;
  receiver_user_id: string | null;
  source_branch_id: string | null;
  source_confirmed_by_user_id: string | null;
  source_confirmed_at: string | null;
  source_confirmation_notes: string | null;
  source_confirmed_amount: number | string | null;
  source_confirmation_proof_url: string | null;
  receiver_role: string | null;
  confirmed_received_amount: number | string | null;
  confirmation_note: string | null;
  transfer_reference_no: string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  confirmation_notes: string | null;
  confirmation_proof_url: string | null;
  destination_confirmed_by_user_id: string | null;
  destination_confirmed_at: string | null;
  destination_confirmation_notes: string | null;
  destination_received_amount: number | string | null;
  destination_confirmation_proof_url: string | null;
  related_transaction_id: string | null;
  created_at: string;
  updated_at: string;
  branches?: BranchRow | BranchRow[] | null;
  source_branch?: BranchRow | BranchRow[] | null;
  requested_by?: UserSummaryRow | UserSummaryRow[] | null;
  reviewed_by?: UserSummaryRow | UserSummaryRow[] | null;
  transferred_by?: UserSummaryRow | UserSummaryRow[] | null;
  source_confirmed_by?: UserSummaryRow | UserSummaryRow[] | null;
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
  transfer_mode,
  flow_type,
  receiver_user_id,
  source_branch_id,
  source_confirmed_by_user_id,
  source_confirmed_at,
  source_confirmation_notes,
  source_confirmed_amount,
  source_confirmation_proof_url,
  receiver_role,
  confirmed_received_amount,
  confirmation_note,
  transfer_reference_no,
  confirmation_proof_url,
  confirmed_at,
  confirmation_notes,
  destination_confirmed_by_user_id,
  destination_confirmed_at,
  destination_confirmation_notes,
  destination_received_amount,
  destination_confirmation_proof_url,
  related_transaction_id,
  created_at,
  updated_at,
  branches:branches!branch_id(id, name, branch_code, location),
  source_branch:source_branch_id(id, name, branch_code, location),
  requested_by:requested_by_user_id(id, full_name, email),
  reviewed_by:reviewed_by_user_id(id, full_name, email),
  transferred_by:transferred_by_user_id(id, full_name, email),
  source_confirmed_by:source_confirmed_by_user_id(id, full_name, email),
  confirmed_by:confirmed_by_user_id(id, full_name, email)
`;

@Injectable()
export class FundRequestsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly activityLogsService: ActivityLogsService,
    private readonly notificationsService: NotificationsService,
    private readonly encryption: EncryptionService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
  ) {}

  /** Manila calendar date key YYYYMMDD for request/transfer numbering. */
  private phDateKey(d = new Date()): string {
    return getPhCalendarDateString(d).replace(/-/g, '');
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

  private isPendingSourceConfirmationRow(
    row: Pick<
      FundRequestRow,
      'status' | 'source_branch_id' | 'transferred_at' | 'source_confirmed_at'
    >,
  ): boolean {
    if (row.status === 'pending_source_confirmation') {
      return !!row.source_branch_id;
    }
    return (
      row.status === 'approved' &&
      !!row.source_branch_id &&
      !!row.transferred_at &&
      !row.source_confirmed_at
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

  private sanitizePathPart(value: string): string {
    return value
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private getUploadContentType(fileData: string, fileName?: string): string {
    if (fileData.startsWith('data:')) {
      const header = fileData.slice(0, fileData.indexOf(','));
      const match = header.match(/^data:([^;]+);base64$/i);
      if (match?.[1]) {
        return match[1];
      }
    }

    if (fileName) {
      const ext = fileName.split('.').pop()?.toLowerCase();
      if (ext === 'png') return 'image/png';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'gif') return 'image/gif';
    }

    return 'image/jpeg';
  }

  private getUploadExtension(fileData: string, fileName?: string): string {
    if (fileName && fileName.includes('.')) {
      return fileName.split('.').pop()?.toLowerCase() ?? 'jpg';
    }

    if (fileData.startsWith('data:')) {
      const header = fileData.slice(0, fileData.indexOf(','));
      const match = header.match(/^data:[^/]+\/([^;]+);base64$/i);
      if (match?.[1]) {
        const ext = match[1].toLowerCase();
        if (ext === 'jpeg') return 'jpg';
        return ext;
      }
    }

    return 'jpg';
  }

  async uploadProof(
    user: AuthenticatedUserProfile,
    dto: UploadFundTransferProofDto,
  ) {
    if (
      user.role !== Role.SUPER_ADMIN &&
      user.role !== Role.ADMIN &&
      user.role !== Role.EMPLOYEE
    ) {
      throw new ForbiddenException(
        'You are not allowed to upload fund transfer proofs',
      );
    }

    const branchId =
      user.role === Role.SUPER_ADMIN
        ? dto.branchId?.trim() || 'super-admin'
        : requireUserBranchId(user);

    const client = this.supabaseService.getClient();
    const base64Data = dto.fileData.includes(',')
      ? dto.fileData.split(',')[1]
      : dto.fileData;
    const fileBuffer = Buffer.from(base64Data, 'base64');

    const extension = this.getUploadExtension(dto.fileData, dto.fileName);
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];
    if (!allowedExtensions.includes(extension)) {
      throw new BadRequestException(
        'Invalid file extension. Only JPG, PNG, and WEBP are allowed.',
      );
    }

    const contentType = this.getUploadContentType(dto.fileData, dto.fileName);
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(contentType)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, and WEBP are allowed.',
      );
    }

    const MAX_SIZE = 5 * 1024 * 1024;
    if (fileBuffer.length > MAX_SIZE) {
      throw new BadRequestException('File is too large. Maximum size is 5MB.');
    }

    const requestPart = this.sanitizePathPart(dto.requestNo || 'fund-request');
    const stagePart = this.sanitizePathPart(dto.stage);
    const branchPart = this.sanitizePathPart(branchId);
    const filePath = `${branchPart}/${requestPart}/${stagePart}-${Date.now()}.${extension}`;

    const { error } = await client.storage
      .from('fund-transfer-proofs')
      .upload(filePath, fileBuffer, {
        upsert: true,
        contentType: contentType,
      });

    if (error) {
      throw new InternalServerErrorException(
        `Proof upload failed: ${error.message}`,
      );
    }

    const { data } = client.storage
      .from('fund-transfer-proofs')
      .getPublicUrl(filePath);
    return { proofUrl: data.publicUrl };
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
    return {
      ...data,
      full_name: this.encryption.decryptUserFullName(data.full_name),
    };
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
    const sourceBranch = Array.isArray(row.source_branch)
      ? (row.source_branch[0] ?? null)
      : (row.source_branch ?? null);
    const requestedBy = Array.isArray(row.requested_by)
      ? (row.requested_by[0] ?? null)
      : (row.requested_by ?? null);
    const reviewedBy = Array.isArray(row.reviewed_by)
      ? (row.reviewed_by[0] ?? null)
      : (row.reviewed_by ?? null);
    const transferredBy = Array.isArray(row.transferred_by)
      ? (row.transferred_by[0] ?? null)
      : (row.transferred_by ?? null);
    const sourceConfirmedBy = Array.isArray(row.source_confirmed_by)
      ? (row.source_confirmed_by[0] ?? null)
      : (row.source_confirmed_by ?? null);
    const confirmedByRaw = Array.isArray(row.confirmed_by)
      ? (row.confirmed_by[0] ?? null)
      : (row.confirmed_by ?? null);

    const sourceConfirmedByDec = sourceConfirmedBy
      ? this.encryption.decryptUsersJoin(sourceConfirmedBy)
      : null;
    const confirmedByDec = confirmedByRaw
      ? this.encryption.decryptUsersJoin(confirmedByRaw)
      : null;
    const requestedByDec = requestedBy
      ? this.encryption.decryptUsersJoin(requestedBy)
      : null;
    const reviewedByDec = reviewedBy
      ? this.encryption.decryptUsersJoin(reviewedBy)
      : null;
    const transferredByDec = transferredBy
      ? this.encryption.decryptUsersJoin(transferredBy)
      : null;

    return {
      id: row.id,
      requestNo: row.request_no,
      branchId: row.branch_id,
      requestedByUserId: row.requested_by_user_id,
      amountRequested: this.toMoneyOrNull(row.amount_requested) ?? 0,
      purpose: row.purpose,
      notes: row.notes,
      status: this.isPendingSourceConfirmationRow(row)
        ? 'pending_source_confirmation'
        : this.isPendingConfirmationRow(row)
          ? 'pending_confirmation'
          : row.status,
      approvedAmount: this.toMoneyOrNull(row.approved_amount),
      reviewedAt: row.reviewed_at,
      reviewNotes: row.review_notes,
      amountTransferred: this.toMoneyOrNull(row.amount_transferred),
      transferredAt: row.transferred_at,
      transferReference: row.transfer_reference,
      transferNotes: row.transfer_notes,
      transferMode: row.transfer_mode,
      flowType: row.flow_type ?? 'request_based',
      receiverUserId: row.receiver_user_id,
      sourceBranchId: row.source_branch_id,
      sourceBranch: sourceBranch
        ? {
            id: sourceBranch.id,
            name: sourceBranch.name,
            branchCode: sourceBranch.branch_code,
            location: sourceBranch.location,
          }
        : null,
      sourceConfirmedBy: sourceConfirmedByDec
        ? {
            id: sourceConfirmedBy!.id,
            fullName: sourceConfirmedByDec.full_name,
            email: sourceConfirmedByDec.email,
          }
        : null,
      sourceConfirmedAt: row.source_confirmed_at,
      sourceConfirmationNotes: row.source_confirmation_notes,
      sourceConfirmedAmount: this.toMoneyOrNull(row.source_confirmed_amount),
      sourceConfirmationProofUrl: row.source_confirmation_proof_url,
      receiverRole: row.receiver_role,
      confirmedReceivedAmount: this.toMoneyOrNull(
        row.confirmed_received_amount,
      ),
      confirmationNote: row.confirmation_note,
      transferReferenceNo: row.transfer_reference_no,
      confirmationProofUrl: row.confirmation_proof_url,
      confirmedAt: row.confirmed_at,
      confirmationNotes: row.confirmation_notes,
      destinationConfirmedBy: confirmedByDec
        ? {
            id: confirmedByRaw!.id,
            fullName: confirmedByDec.full_name,
            email: confirmedByDec.email,
          }
        : null,
      destinationConfirmedAt: row.destination_confirmed_at,
      destinationConfirmationNotes: row.destination_confirmation_notes,
      destinationReceivedAmount: this.toMoneyOrNull(
        row.destination_received_amount,
      ),
      destinationConfirmationProofUrl: row.destination_confirmation_proof_url,
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
      requestedBy: requestedByDec
        ? {
            id: requestedBy!.id,
            fullName: requestedByDec.full_name,
            email: requestedByDec.email,
          }
        : null,
      reviewedBy: reviewedByDec
        ? {
            id: reviewedBy!.id,
            fullName: reviewedByDec.full_name,
            email: reviewedByDec.email,
          }
        : null,
      transferredBy: transferredByDec
        ? {
            id: transferredBy!.id,
            fullName: transferredByDec.full_name,
            email: transferredByDec.email,
          }
        : null,
      confirmedBy: confirmedByDec
        ? {
            id: confirmedByRaw!.id,
            fullName: confirmedByDec.full_name,
            email: confirmedByDec.email,
          }
        : null,
    };
  }

  private async createTransferTransaction(params: {
    branch: BranchRow;
    request: FundRequestRow;
    amount: number;
    transferReference: string | null;
    transferNotes: string | null;
    referenceId?: string | null;
    direction: 'in' | 'out';
    counterpartBranchName?: string | null;
  }): Promise<{ id: string }> {
    const now = new Date();
    const prefix = `FT-${this.phDateKey(now)}-`;
    const transactionNo = await this.getNextCode(
      'transactions',
      'transaction_no',
      prefix,
    );
    const isInbound = params.direction === 'in';
    const detailsParts = isInbound
      ? [
          `Fund transfer for ${params.request.request_no}`,
          params.request.purpose ? `Purpose: ${params.request.purpose}` : '',
          params.transferReference
            ? `Reference: ${params.transferReference}`
            : '',
          params.transferNotes ? `Notes: ${params.transferNotes}` : '',
        ].filter(Boolean)
      : [
          `Transfer out for ${params.request.request_no}`,
          params.counterpartBranchName
            ? `Destination: ${params.counterpartBranchName}`
            : '',
          params.request.purpose ? `Purpose: ${params.request.purpose}` : '',
          params.transferReference
            ? `Reference: ${params.transferReference}`
            : '',
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
        // Align with Prisma/daily_balances: Asia/Manila business date (not UTC).
        transaction_date: getPhCalendarDateString(now),
        transaction_time: now.toTimeString().slice(0, 8),
        cash_in: isInbound ? params.amount : 0,
        cash_out: isInbound ? 0 : params.amount,
        return_amount: 0,
        unit: isInbound ? 'fund_transfer' : 'fund_transfer_out',
        unit_code: params.referenceId ?? params.request.request_no,
        pawn_amount: 0,
        storage_fee: 0,
        details: this.encryption.encryptTransactionDetails(
          detailsParts.join(' | '),
        ),
      })
      .select('id')
      .single<{ id: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  private async createOwnerOutTransferTransaction(params: {
    request: FundRequestRow;
    amount: number;
    transferReference: string | null;
    transferNotes: string | null;
    referenceId: string;
    destinationBranchName: string;
  }): Promise<{ id: string }> {
    const now = new Date();
    const prefix = `FT-${this.phDateKey(now)}-`;
    const transactionNo = await this.getNextCode(
      'transactions',
      'transaction_no',
      prefix,
    );

    const details = [
      `Owner transfer out for ${params.request.request_no}`,
      `Destination: ${params.destinationBranchName}`,
      params.transferReference ? `Reference: ${params.transferReference}` : '',
      params.transferNotes ? `Notes: ${params.transferNotes}` : '',
      `Linked Ref ID: ${params.referenceId}`,
    ]
      .filter(Boolean)
      .join(' | ');

    const { data, error } = await this.supabaseService
      .getClient()
      .from('transactions')
      .insert({
        transaction_no: transactionNo,
        branch_id: null,
        branch: 'System / Head Office',
        purpose: 'Fund Transfer',
        transaction_date: getPhCalendarDateString(now),
        transaction_time: now.toTimeString().slice(0, 8),
        cash_in: 0,
        cash_out: params.amount,
        return_amount: 0,
        unit: 'fund_transfer_out',
        unit_code: params.referenceId,
        pawn_amount: 0,
        storage_fee: 0,
        details: this.encryption.encryptTransactionDetails(details),
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
      const prefix = `FT-${this.phDateKey(now)}-`;
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
          purpose: 'Fund Transfer',
          transaction_date: getPhCalendarDateString(now),
          transaction_time: now.toTimeString().slice(0, 8),
          cash_in: 0,
          cash_out: params.amount,
          return_amount: 0,
          unit: 'fund_transfer_out',
          unit_code: params.request.request_no,
          pawn_amount: 0,
          storage_fee: 0,
          details: this.encryption.encryptTransactionDetails(
            `Transfer out to ${params.destinationBranch.name} | Ref: ${params.transferReference ?? 'N/A'} | Notes: ${params.transferNotes ?? '-'}`,
          ),
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
      direction: 'in',
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

  private async notifyBranch(params: {
    branchId: string | null | undefined;
    title: string;
    subtitle: string;
    category: 'Transactions' | 'Alerts' | 'Requests';
  }) {
    if (!params.branchId) return;

    await this.notificationsService.create({
      title: params.title,
      subtitle: params.subtitle,
      category: params.category,
      branch_id: params.branchId,
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
      `FR-${this.phDateKey(now)}-`,
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

    try {
      await this.notifyBranch({
        branchId: branch.id,
        title: 'New fund request submitted',
        subtitle: `${mapped.branch?.name ?? 'A branch'} submitted ${mapped.requestNo} for ₱${mapped.amountRequested.toFixed(2)}${mapped.purpose ? ` (${mapped.purpose})` : ''}.`,
        category: 'Requests',
      });
    } catch (notifErr) {
      console.error(
        '[FundRequestsService] Failed to notify super admins about fund request creation:',
        notifErr,
      );
    }

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
      `DF-${this.phDateKey(now)}-`,
    );
    const amount = this.normalizeMoney(dto.amount);
    const transferMode = dto.transferMode ?? 'cash';
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
        status: sourceBranch
          ? 'pending_source_confirmation'
          : 'pending_confirmation',
        approved_amount: amount,
        reviewed_by_user_id: user.id,
        reviewed_at: now.toISOString(),
        amount_transferred: amount,
        transferred_by_user_id: user.id,
        transferred_at: now.toISOString(),
        transfer_reference: this.compactText(dto.transferReference),
        transfer_notes: this.compactText(dto.notes),
        transfer_mode: transferMode,
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
          transfer_mode: transferMode,
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
        transferMode,
        sourceBranchId: sourceBranch?.id ?? null,
        destinationBranchId: destinationBranch.id,
        awaitingSourceConfirmation: !!sourceBranch,
      },
    });

    try {
      const transferSubtitle = sourceBranch
        ? `${mapped.requestNo} is awaiting source confirmation from ${sourceBranch.name} before ${destinationBranch.name} can receive ₱${mapped.amountTransferred?.toFixed(2) ?? amount.toFixed(2)}.`
        : `${mapped.requestNo} is ready for ${destinationBranch.name} to confirm receipt of ₱${mapped.amountTransferred?.toFixed(2) ?? amount.toFixed(2)}.`;

      if (sourceBranch) {
        await Promise.all([
          this.notifyBranch({
            branchId: sourceBranch.id,
            title: 'Branch transfer requires source confirmation',
            subtitle: `${mapped.requestNo} will be deducted from ${sourceBranch.name} for ${destinationBranch.name}.`,
            category: 'Requests',
          }),
          this.notifyBranch({
            branchId: destinationBranch.id,
            title: 'Incoming branch transfer scheduled',
            subtitle: transferSubtitle,
            category: 'Requests',
          }),
        ]);
      } else {
        await this.notifyBranch({
          branchId: destinationBranch.id,
          title: 'Fund transfer awaiting receipt confirmation',
          subtitle: transferSubtitle,
          category: 'Requests',
        });
      }
    } catch (notifErr) {
      console.error(
        '[FundRequestsService] Failed to notify direct transfer recipients:',
        notifErr,
      );
    }

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
      if (user.role === Role.SUPER_ADMIN) {
        query = query.or(
          `branch_id.eq.${branchId},source_branch_id.eq.${branchId}`,
        );
      } else {
        query = query.or(
          `branch_id.eq.${branchId},source_branch_id.eq.${branchId}`,
        );
      }
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
    if (user.role !== Role.SUPER_ADMIN) {
      const branchId = requireUserBranchId(user);
      if (
        fundRequest.branch_id !== branchId &&
        fundRequest.source_branch_id !== branchId
      ) {
        throw new ForbiddenException(
          'You cannot access data from another branch',
        );
      }
    }
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

    try {
      await this.notifyBranch({
        branchId: mapped.branchId,
        title:
          dto.decision === FundRequestReviewDecision.APPROVED
            ? 'Fund request approved'
            : 'Fund request rejected',
        subtitle:
          dto.decision === FundRequestReviewDecision.APPROVED
            ? `${mapped.requestNo} was approved for ₱${(mapped.approvedAmount ?? mapped.amountRequested).toFixed(2)}.`
            : `${mapped.requestNo} was rejected by Super Admin.`,
        category: 'Requests',
      });
    } catch (notifErr) {
      console.error(
        '[FundRequestsService] Failed to notify branch about review result:',
        notifErr,
      );
    }

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

    const destinationBranch = Array.isArray(existing.branches)
      ? (existing.branches[0] ?? null)
      : (existing.branches ?? null);
    const resolvedDestinationBranch =
      destinationBranch ?? (await this.getBranchById(existing.branch_id));
    const sourceBranch = dto.sourceBranchId
      ? await this.getBranchById(dto.sourceBranchId)
      : existing.source_branch_id
        ? await this.getBranchById(existing.source_branch_id)
        : null;

    if (sourceBranch && sourceBranch.id === resolvedDestinationBranch.id) {
      throw new BadRequestException(
        'Source and destination branch cannot be the same',
      );
    }

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

    if (sourceBranch) {
      const sourceBalance = await this.getLatestBranchBalance(sourceBranch.id);
      if (sourceBalance < transferAmount) {
        throw new BadRequestException(
          `Source branch has insufficient cash on hand. Available: ${sourceBalance.toFixed(2)}`,
        );
      }
    }

    const receiver = await this.resolveReceiver({
      branchId: existing.branch_id,
      receiverRole: dto.receiverRole,
      receiverUserId: dto.receiverUserId,
    });

    const transferMode = dto.transferMode ?? existing.transfer_mode ?? 'cash';
    const now = new Date();
    const status = sourceBranch
      ? 'pending_source_confirmation'
      : 'pending_confirmation';

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({
        status,
        approved_amount:
          this.toMoneyOrNull(existing.approved_amount) ?? transferAmount,
        reviewed_by_user_id: existing.reviewed_by_user_id ?? user.id,
        reviewed_at: existing.reviewed_at ?? new Date().toISOString(),
        review_notes: this.compactText(existing.review_notes),
        amount_transferred: transferAmount,
        transferred_by_user_id: user.id,
        transferred_at: now.toISOString(),
        transfer_reference: this.compactText(dto.transferReference),
        transfer_notes: this.compactText(dto.transferNotes),
        transfer_reference_no: this.compactText(dto.transferReference),
        transfer_mode: transferMode,
        source_branch_id: sourceBranch?.id ?? existing.source_branch_id,
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
          transferred_at: now.toISOString(),
          transfer_reference: this.compactText(dto.transferReference),
          transfer_notes: this.compactText(dto.transferNotes),
          transfer_reference_no: this.compactText(dto.transferReference),
          transfer_mode: transferMode,
          source_branch_id: sourceBranch?.id ?? existing.source_branch_id,
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
        transferMode,
        sourceBranchId: sourceBranch?.id ?? null,
        destinationBranchId: resolvedDestinationBranch.id,
        awaitingSourceConfirmation: !!sourceBranch,
      },
    });
    return mapped;
  }

  async sourceConfirm(
    user: AuthenticatedUserProfile,
    id: string,
    dto: SourceConfirmFundRequestDto,
  ) {
    if (user.role !== Role.ADMIN && user.role !== Role.EMPLOYEE) {
      throw new ForbiddenException(
        'Only branch admins or employees can confirm source deductions',
      );
    }

    const existing = await this.getFundRequestById(id);
    if (!existing.source_branch_id) {
      throw new BadRequestException(
        'This transfer is not routed through another branch',
      );
    }

    assertResourceBranch(user, existing.source_branch_id);

    if (!this.isPendingSourceConfirmationRow(existing)) {
      throw new BadRequestException(
        'Only pending source confirmation requests can be confirmed',
      );
    }

    const sourceBranch = await this.getBranchById(existing.source_branch_id);
    const destinationBranch = await this.getBranchById(existing.branch_id);
    const sentAmount = this.normalizeMoney(
      dto.sentAmount ??
        this.toMoneyOrNull(existing.amount_transferred) ??
        this.toMoneyOrNull(existing.approved_amount) ??
        this.toMoneyOrNull(existing.amount_requested) ??
        0,
    );
    const transferAmount = this.normalizeMoney(
      this.toMoneyOrNull(existing.amount_transferred) ??
        this.toMoneyOrNull(existing.approved_amount) ??
        this.toMoneyOrNull(existing.amount_requested) ??
        0,
    );

    if (sentAmount > transferAmount) {
      throw new BadRequestException(
        'Sent amount cannot exceed the amount released for transfer',
      );
    }

    const sourceBalance = await this.getLatestBranchBalance(sourceBranch.id);
    if (sourceBalance < sentAmount) {
      throw new BadRequestException(
        `Source branch has insufficient cash on hand. Available: ${sourceBalance.toFixed(2)}`,
      );
    }

    const transferReference =
      this.compactText(existing.transfer_reference_no) ??
      this.compactText(existing.transfer_reference);

    let outboundTransactionId: string | null = null;
    try {
      const outboundTransaction = await this.createTransferTransaction({
        branch: sourceBranch,
        request: existing,
        amount: sentAmount,
        transferReference,
        transferNotes:
          this.compactText(dto.confirmationNotes) ??
          this.compactText(existing.transfer_notes),
        referenceId:
          this.compactText(existing.transfer_reference_no) ??
          this.compactText(existing.transfer_reference) ??
          existing.request_no,
        direction: 'out',
        counterpartBranchName: destinationBranch.name,
      });
      outboundTransactionId = outboundTransaction.id;
      await this.financeDailyBalance.applyNetChange(
        sourceBranch.id,
        getPhCalendarDateString(),
        -sentAmount,
        undefined,
        { bypassOperationalSessionGate: true },
      );
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err ?? '');
      if (this.isTransactionsPurposeConstraintError(errorMessage)) {
        await this.financeDailyBalance.applyNetChange(
          sourceBranch.id,
          getPhCalendarDateString(),
          -sentAmount,
          undefined,
          { bypassOperationalSessionGate: true },
        );
      } else {
        throw err;
      }
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('fund_requests')
      .update({
        status: 'pending_confirmation',
        amount_transferred: sentAmount,
        source_confirmed_by_user_id: user.id,
        source_confirmed_at: new Date().toISOString(),
        source_confirmation_notes: this.compactText(dto.confirmationNotes),
        source_confirmed_amount: sentAmount,
        source_confirmation_proof_url: this.compactText(dto.proofUrl),
        transfer_mode: existing.transfer_mode,
        related_transaction_id: outboundTransactionId,
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
      branchId: sourceBranch.id,
      action: 'FUND_TRANSFER_SOURCE_CONFIRMED',
      details: {
        requestNo: mapped.requestNo,
        sourceBranchId: sourceBranch.id,
        destinationBranchId: destinationBranch.id,
        sentAmount,
        transferMode: existing.transfer_mode,
        relatedTransactionId: outboundTransactionId,
      },
    });

    try {
      await this.notifyBranch({
        branchId: destinationBranch.id,
        title: 'Branch transfer ready for receipt confirmation',
        subtitle: `${mapped.requestNo} was released by ${sourceBranch.name} for ₱${sentAmount.toFixed(2)} and is waiting for ${destinationBranch.name} to confirm receipt.`,
        category: 'Requests',
      });
    } catch (notifErr) {
      console.error(
        '[FundRequestsService] Failed to notify destination branch after source confirmation:',
        notifErr,
      );
    }

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
      throw new BadRequestException(
        'Only pending confirmation requests can be confirmed',
      );
    }

    if (existing.receiver_user_id && existing.receiver_user_id !== user.id) {
      throw new ForbiddenException(
        'This transfer is assigned to another receiver',
      );
    }

    if (
      !existing.receiver_user_id &&
      existing.receiver_role &&
      existing.receiver_role !== this.toReceiverRole(user.role)
    ) {
      const employeeMayConfirmAdminReceiverHint =
        user.role === Role.EMPLOYEE && existing.receiver_role === 'admin';
      const adminMayConfirmEmployeeReceiverHint =
        user.role === Role.ADMIN && existing.receiver_role === 'employee';
      if (
        !employeeMayConfirmAdminReceiverHint &&
        !adminMayConfirmEmployeeReceiverHint
      ) {
        throw new ForbiddenException(
          'Your role is not allowed to confirm this transfer',
        );
      }
    }

    const destinationBranch = Array.isArray(existing.branches)
      ? (existing.branches[0] ?? null)
      : (existing.branches ?? null);
    const resolvedDestinationBranch =
      destinationBranch ?? (await this.getBranchById(existing.branch_id));
    const transferAmount =
      this.toMoneyOrNull(existing.amount_transferred) ??
      this.toMoneyOrNull(existing.approved_amount) ??
      this.toMoneyOrNull(existing.amount_requested);
    const confirmedAmount = this.normalizeMoney(
      dto.receivedAmount ?? transferAmount ?? 0,
    );

    if (transferAmount != null && confirmedAmount > transferAmount) {
      throw new BadRequestException(
        'Received amount cannot exceed the amount released for transfer',
      );
    }

    let inboundTransactionId: string | null = null;
    let ownerOutTransactionId: string | null = null;
    try {
      const referenceId =
        this.compactText(existing.transfer_reference_no) ??
        this.compactText(existing.transfer_reference) ??
        existing.request_no;
      const isExpenseTransfer = existing.purpose
        ?.toLowerCase()
        .includes('expense');

      if (!existing.source_branch_id && !isExpenseTransfer) {
        const ownerOutTransaction =
          await this.createOwnerOutTransferTransaction({
            request: existing,
            amount: confirmedAmount,
            transferReference:
              this.compactText(existing.transfer_reference_no) ??
              this.compactText(existing.transfer_reference),
            transferNotes:
              this.compactText(dto.confirmationNotes) ??
              this.compactText(existing.transfer_notes),
            referenceId,
            destinationBranchName: resolvedDestinationBranch.name,
          });
        ownerOutTransactionId = ownerOutTransaction.id;
      }

      const inboundTransaction = await this.createTransferTransaction({
        branch: resolvedDestinationBranch,
        request: existing,
        amount: confirmedAmount,
        transferReference:
          this.compactText(existing.transfer_reference_no) ??
          this.compactText(existing.transfer_reference),
        transferNotes:
          this.compactText(dto.confirmationNotes) ??
          this.compactText(existing.transfer_notes),
        referenceId,
        direction: isExpenseTransfer ? 'out' : 'in',
      });
      inboundTransactionId = inboundTransaction.id;
      const balanceDelta = isExpenseTransfer
        ? -confirmedAmount
        : confirmedAmount;
      await this.financeDailyBalance.applyNetChange(
        existing.branch_id,
        getPhCalendarDateString(),
        balanceDelta,
        undefined,
        { bypassOperationalSessionGate: true },
      );
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err ?? '');
      if (this.isTransactionsPurposeConstraintError(errorMessage)) {
        // Allow confirmation to proceed even if legacy transactions purpose
        // constraint rejects fund-transfer journal entries.
        const balanceDeltaFallback = existing.purpose
          ?.toLowerCase()
          .includes('expense')
          ? -confirmedAmount
          : confirmedAmount;
        await this.financeDailyBalance.applyNetChange(
          existing.branch_id,
          getPhCalendarDateString(),
          balanceDeltaFallback,
          undefined,
          { bypassOperationalSessionGate: true },
        );
      } else {
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
        confirmation_proof_url: this.compactText(dto.proofUrl),
        destination_confirmed_by_user_id: user.id,
        destination_confirmed_at: new Date().toISOString(),
        destination_confirmation_notes: this.compactText(dto.confirmationNotes),
        destination_received_amount: confirmedAmount,
        destination_confirmation_proof_url: this.compactText(dto.proofUrl),
        related_transaction_id: inboundTransactionId ?? ownerOutTransactionId,
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
        destinationBranchId: resolvedDestinationBranch.id,
        sourceBranchId: mapped.sourceBranchId,
        confirmationProofUrl: mapped.confirmationProofUrl,
      },
    });

    try {
      if (mapped.sourceBranchId) {
        await this.notifyBranch({
          branchId: mapped.sourceBranchId,
          title: 'Branch transfer completed',
          subtitle: `${mapped.requestNo} was received by ${resolvedDestinationBranch.name} for ₱${mapped.confirmedReceivedAmount?.toFixed(2) ?? confirmedAmount.toFixed(2)}.`,
          category: 'Requests',
        });
      }
    } catch (notifErr) {
      console.error(
        '[FundRequestsService] Failed to notify source branch after transfer confirmation:',
        notifErr,
      );
    }

    await this.writeFundLog({
      user,
      branchId: mapped.branchId,
      action: 'BRANCH_CASH_ON_HAND_UPDATED',
      details: {
        requestNo: mapped.requestNo,
        delta:
          existing.purpose?.toLowerCase().includes('expense') &&
          mapped.confirmedReceivedAmount
            ? -mapped.confirmedReceivedAmount
            : mapped.confirmedReceivedAmount,
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
