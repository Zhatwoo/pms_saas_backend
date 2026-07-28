import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import {
  CreateQRReplacementRequestDto,
  ApproveQRReplacementRequestDto,
  RejectQRReplacementRequestDto,
} from '../dto/qr-replacement-request.dto';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import {
  assertBranchAccess,
  environmentCreateFields,
  getEnvironment,
  requireBranchId,
} from '../../../common/utils/authorization.util';

export interface QrReplacementRequestRow {
  id: string;
  pawned_item_id: string;
  requested_by: string;
  branch_id: string;
  reason: string;
  description: string | null;
  status: string;
  created_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  approval_notes?: string | null;
  rejection_reason?: string | null;
  completed_at?: string | null;
  environment?: string;
  [key: string]: unknown;
}

@Injectable()
export class QRReplacementRequestsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async createRequest(
    user: AuthenticatedUserProfile,
    pawnedItemId: string,
    dto: CreateQRReplacementRequestDto,
  ): Promise<QrReplacementRequestRow> {
    const supabase = this.supabaseService.getClient();
    const branchId = requireBranchId(user);

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow | null; error: unknown } = await supabase
      .from('qr_replacement_requests')
      .insert({
        pawned_item_id: pawnedItemId,
        requested_by: user.id,
        branch_id: branchId,
        reason: dto.reason,
        description: dto.description || null,
        status: 'pending',
        created_at: new Date().toISOString(),
        ...environmentCreateFields(user),
      })
      .select()
      .single();

    if (error)
      throw new Error(
        `Failed to create QR replacement request: ${this.errorMessage(error)}`,
      );
    if (!data) throw new Error('Failed to create QR replacement request');
    return data;
  }

  async getRequestsByBranch(
    user: AuthenticatedUserProfile,
    branchId: string,
  ): Promise<QrReplacementRequestRow[]> {
    const supabase = this.supabaseService.getClient();
    assertBranchAccess(user, branchId);

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow[] | null; error: unknown } =
      await supabase
        .from('qr_replacement_requests')
        .select(
          '*, requested_by_user:requested_by(id, full_name, email), pawned_item:pawned_item_id(qr_code, item_id)',
        )
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .order('created_at', { ascending: false });

    if (error)
      throw new Error(`Failed to fetch requests: ${this.errorMessage(error)}`);
    return data ?? [];
  }

  async getRequestsByStatus(
    user: AuthenticatedUserProfile,
    branchId: string,
    status: string,
  ): Promise<QrReplacementRequestRow[]> {
    const supabase = this.supabaseService.getClient();
    assertBranchAccess(user, branchId);

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow[] | null; error: unknown } =
      await supabase
        .from('qr_replacement_requests')
        .select('*, requested_by_user:requested_by(id, full_name, email)')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .eq('status', status)
        .order('created_at', { ascending: false });

    if (error)
      throw new Error(
        `Failed to fetch requests by status: ${this.errorMessage(error)}`,
      );
    return data ?? [];
  }

  async getRequestById(
    user: AuthenticatedUserProfile,
    requestId: string,
  ): Promise<QrReplacementRequestRow> {
    const supabase = this.supabaseService.getClient();

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow | null; error: unknown } = await supabase
      .from('qr_replacement_requests')
      .select('*')
      .eq('id', requestId)
      .eq('environment', getEnvironment(user))
      .single();

    if (error)
      throw new Error(`Failed to fetch request: ${this.errorMessage(error)}`);
    if (!data) throw new Error('QR replacement request not found');
    return data;
  }

  async approveRequest(
    requestId: string,
    user: AuthenticatedUserProfile,
    dto: ApproveQRReplacementRequestDto,
  ): Promise<QrReplacementRequestRow> {
    const supabase = this.supabaseService.getClient();

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow | null; error: unknown } = await supabase
      .from('qr_replacement_requests')
      .update({
        status: 'approved',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        approval_notes: dto.notes || null,
      })
      .eq('id', requestId)
      .eq('environment', getEnvironment(user))
      .select()
      .single();

    if (error)
      throw new Error(`Failed to approve request: ${this.errorMessage(error)}`);
    if (!data) throw new Error('QR replacement request not found');
    return data;
  }

  async rejectRequest(
    requestId: string,
    user: AuthenticatedUserProfile,
    dto: RejectQRReplacementRequestDto,
  ): Promise<QrReplacementRequestRow> {
    const supabase = this.supabaseService.getClient();

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow | null; error: unknown } = await supabase
      .from('qr_replacement_requests')
      .update({
        status: 'rejected',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        rejection_reason: dto.rejectionReason,
      })
      .eq('id', requestId)
      .eq('environment', getEnvironment(user))
      .select()
      .single();

    if (error)
      throw new Error(`Failed to reject request: ${this.errorMessage(error)}`);
    if (!data) throw new Error('QR replacement request not found');
    return data;
  }

  async markAsCompleted(
    user: AuthenticatedUserProfile,
    requestId: string,
  ): Promise<QrReplacementRequestRow> {
    const supabase = this.supabaseService.getClient();

    const {
      data,
      error,
    }: { data: QrReplacementRequestRow | null; error: unknown } = await supabase
      .from('qr_replacement_requests')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .eq('environment', getEnvironment(user))
      .select()
      .single();

    if (error)
      throw new Error(
        `Failed to mark request as completed: ${this.errorMessage(error)}`,
      );
    if (!data) throw new Error('QR replacement request not found');
    return data;
  }

  private errorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return 'Unknown error';
  }

  async checkIfQRCanBeGenerated(
    user: AuthenticatedUserProfile,
    pawnedItemId: string,
  ) {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('qr_replacement_requests')
      .select('id, status')
      .eq('pawned_item_id', pawnedItemId)
      .eq('environment', getEnvironment(user))
      .eq('status', 'approved')
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(
        `Failed to check QR replacement status: ${error.message}`,
      );
    }

    return !!data;
  }
}
