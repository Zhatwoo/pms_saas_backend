import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../common/enums';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../infrastructure/supabase/supabase.service';

interface CreateIncidentTicketDto {
  title?: string;
  summary?: string;
  category?: string;
  priority?: string;
  branchId?: string;
  userId?: string | null;
  amountImpact?: number | null;
  transactionRef?: string | null;
  requiresManagerEscalation?: boolean;
}

interface UpdateIncidentTicketDto {
  status?: string;
  requiresManagerEscalation?: boolean;
  escalationOwnerUserId?: string | null;
  resolutionNotes?: string | null;
}

interface IncidentTicketEventPayload {
  ticketId: string;
  branchId: string;
  action:
    | 'reported'
    | 'assigned'
    | 'unassigned'
    | 'escalated'
    | 'resolved'
    | 'reopened';
  actorUserId?: string | null;
  subjectUserId?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class IncidentTicketsService {
  private readonly logger = new Logger(IncidentTicketsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  private ensureBranchAccess(user: AuthenticatedUserProfile, branchId: string) {
    if (user.role === Role.SUPER_ADMIN) return;
    if (!user.branchId || user.branchId !== branchId) {
      throw new ForbiddenException(
        'You cannot access incident tickets for this branch.',
      );
    }
  }

  private ensureManagerAccess(user: AuthenticatedUserProfile) {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.ADMIN) return;
    throw new ForbiddenException(
      'You can only view the status of incident tickets you submitted.',
    );
  }

  async findAll(user: AuthenticatedUserProfile, branch?: string) {
    const client = this.supabaseService.getClient();
    const scopedBranchId =
      user.role === Role.SUPER_ADMIN
        ? branch || undefined
        : user.branchId || undefined;

    let query = client
      .from('incident_tickets')
      .select(
        `
        id,
        ticket_no,
        title,
        summary,
        category,
        priority,
        status,
        source,
        branch_id,
        user_id,
        reported_by_user_id,
        escalation_owner_user_id,
        resolved_by,
        resolved_at,
        resolution_notes,
        reopened_at,
        incident_ticket_events (
          id,
          action,
          actor_user_id,
          subject_user_id,
          notes,
          metadata,
          created_at
        ),
        transaction_ref,
        amount_impact,
        requires_manager_escalation,
        reported_at,
        updated_at
      `,
      )
      .order('reported_at', { ascending: false });

    if (scopedBranchId) {
      query = query.eq('branch_id', scopedBranchId);
    }

    if (user.role === Role.EMPLOYEE) {
      query = query.eq('reported_by_user_id', user.id);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch incident tickets: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to fetch incident tickets',
      );
    }

    return (data ?? []).map((ticket) => ({
      ...ticket,
      incident_ticket_events: [...(ticket.incident_ticket_events ?? [])].sort(
        (a, b) =>
          new Date(a.created_at as string).getTime() -
          new Date(b.created_at as string).getTime(),
      ),
    }));
  }

  async create(user: AuthenticatedUserProfile, dto: CreateIncidentTicketDto) {
    const branchId =
      user.role === Role.SUPER_ADMIN ? dto.branchId : user.branchId;

    if (!branchId) {
      throw new BadRequestException('Branch is required.');
    }

    this.ensureBranchAccess(user, branchId);

    if (!dto.title?.trim() || !dto.summary?.trim() || !dto.category?.trim()) {
      throw new BadRequestException(
        'Title, summary, and category are required.',
      );
    }

    const escalationOwnerUserId = dto.requiresManagerEscalation
      ? await this.resolveManagerId(branchId)
      : null;

    const { data, error } = await this.supabaseService
      .getClient()
      .rpc('raise_incident_ticket', {
        p_title: dto.title.trim(),
        p_summary: dto.summary.trim(),
        p_category: dto.category.trim(),
        p_branch_id: branchId,
        p_priority: dto.priority ?? 'medium',
        p_source: 'manual',
        p_user_id: dto.userId || user.id,
        p_reported_by_user_id: user.id,
        p_escalation_owner_user_id: escalationOwnerUserId,
        p_related_transaction_id: null,
        p_transaction_ref: dto.transactionRef?.trim() || null,
        p_inventory_item_ref: null,
        p_amount_impact:
          typeof dto.amountImpact === 'number' &&
          Number.isFinite(dto.amountImpact)
            ? dto.amountImpact
            : null,
        p_requires_manager_escalation: Boolean(dto.requiresManagerEscalation),
        p_status: dto.requiresManagerEscalation ? 'escalated' : 'open',
        p_metadata: {
          created_from: 'backend-incident-tickets-api',
        },
      });

    if (error) {
      this.logger.error(`Failed to create incident ticket: ${error.message}`);
      throw new InternalServerErrorException(
        error.message || 'Failed to create incident ticket',
      );
    }

    if (data?.id) {
      await this.recordEvent({
        ticketId: data.id as string,
        branchId,
        action: 'reported',
        actorUserId: user.id,
        subjectUserId: dto.userId || user.id,
        notes: dto.summary.trim(),
      });

      if (escalationOwnerUserId) {
        await this.recordEvent({
          ticketId: data.id as string,
          branchId,
          action: 'escalated',
          actorUserId: user.id,
          subjectUserId: escalationOwnerUserId,
          notes: 'Ticket escalated for manager action.',
        });
      }
    }

    return data;
  }

  async update(
    user: AuthenticatedUserProfile,
    id: string,
    dto: UpdateIncidentTicketDto,
  ) {
    const client = this.supabaseService.getClient();

    const { data: existing, error: fetchError } = await client
      .from('incident_tickets')
      .select('id, branch_id, status, escalation_owner_user_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      this.logger.error(
        `Failed to fetch incident ticket ${id}: ${fetchError.message}`,
      );
      throw new InternalServerErrorException('Failed to load incident ticket');
    }

    if (!existing) {
      throw new NotFoundException('Incident ticket not found');
    }

    this.ensureBranchAccess(user, existing.branch_id);
    this.ensureManagerAccess(user);

    const patch: Record<string, unknown> = {};
    const events: IncidentTicketEventPayload[] = [];

    if (dto.status) {
      patch.status = dto.status;

      if (dto.status === 'resolved') {
        const notes = dto.resolutionNotes?.trim();
        if (!notes) {
          throw new BadRequestException('Resolution notes are required.');
        }

        patch.resolved_by = user.id;
        patch.resolved_at = new Date().toISOString();
        patch.resolution_notes = notes;
        patch.requires_manager_escalation = false;
        events.push({
          ticketId: id,
          branchId: existing.branch_id,
          action: 'resolved',
          actorUserId: user.id,
          notes,
        });
      }

      if (dto.status === 'reopened') {
        patch.reopened_at = new Date().toISOString();
        patch.requires_manager_escalation = false;
        events.push({
          ticketId: id,
          branchId: existing.branch_id,
          action: 'reopened',
          actorUserId: user.id,
          notes: 'Ticket reopened.',
        });
      }

      if (dto.status === 'escalated') {
        events.push({
          ticketId: id,
          branchId: existing.branch_id,
          action: 'escalated',
          actorUserId: user.id,
          subjectUserId: dto.escalationOwnerUserId ?? null,
          notes: 'Ticket escalated for manager action.',
        });
      }
    }

    if (typeof dto.requiresManagerEscalation === 'boolean') {
      patch.requires_manager_escalation = dto.requiresManagerEscalation;
    }

    if (dto.escalationOwnerUserId !== undefined) {
      await this.ensureAssigneeAccess(
        user,
        existing.branch_id,
        dto.escalationOwnerUserId,
      );
      patch.escalation_owner_user_id = dto.escalationOwnerUserId;

      if (dto.escalationOwnerUserId !== existing.escalation_owner_user_id) {
        events.push({
          ticketId: id,
          branchId: existing.branch_id,
          action: dto.escalationOwnerUserId ? 'assigned' : 'unassigned',
          actorUserId: user.id,
          subjectUserId: dto.escalationOwnerUserId,
          notes: dto.escalationOwnerUserId
            ? 'Ticket assigned to branch admin.'
            : 'Ticket assignment removed.',
        });
      }
    }

    const { data, error } = await client
      .from('incident_tickets')
      .update(patch)
      .eq('id', id)
      .select(
        `
        id,
        ticket_no,
        title,
        summary,
        category,
        priority,
        status,
        source,
        branch_id,
        user_id,
        reported_by_user_id,
        escalation_owner_user_id,
        resolved_by,
        resolved_at,
        resolution_notes,
        reopened_at,
        incident_ticket_events (
          id,
          action,
          actor_user_id,
          subject_user_id,
          notes,
          metadata,
          created_at
        ),
        transaction_ref,
        amount_impact,
        requires_manager_escalation,
        reported_at,
        updated_at
      `,
      )
      .maybeSingle();

    if (error) {
      this.logger.error(
        `Failed to update incident ticket ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to update incident ticket',
      );
    }

    for (const event of events) {
      await this.recordEvent(event);
    }

    return data;
  }

  private async resolveManagerId(branchId: string) {
    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('users')
      .select('id, role, branch_id')
      .eq('branch_id', branchId)
      .eq('role', Role.ADMIN)
      .limit(1);

    if (error) {
      this.logger.warn(
        `Failed to resolve manager for branch ${branchId}: ${error.message}`,
      );
      return null;
    }

    return data?.[0]?.id ?? null;
  }

  private async ensureAssigneeAccess(
    user: AuthenticatedUserProfile,
    ticketBranchId: string,
    assigneeId?: string | null,
  ) {
    if (!assigneeId) return;

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('users')
      .select('id, role, branch_id')
      .eq('id', assigneeId)
      .maybeSingle();

    if (error) {
      this.logger.warn(
        `Failed to validate incident assignee ${assigneeId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to validate incident assignee',
      );
    }

    if (!data) {
      throw new BadRequestException('Selected assignee was not found.');
    }

    if (data.role !== Role.ADMIN || data.branch_id !== ticketBranchId) {
      throw new ForbiddenException(
        'Incident tickets can only be assigned to branch admins.',
      );
    }
  }

  private async recordEvent(payload: IncidentTicketEventPayload) {
    const { error } = await this.supabaseService
      .getClient()
      .from('incident_ticket_events')
      .insert({
        ticket_id: payload.ticketId,
        branch_id: payload.branchId,
        action: payload.action,
        actor_user_id: payload.actorUserId ?? null,
        subject_user_id: payload.subjectUserId ?? null,
        notes: payload.notes ?? null,
        metadata: payload.metadata ?? {},
      });

    if (error) {
      this.logger.warn(
        `Failed to record incident ticket event for ${payload.ticketId}: ${error.message}`,
      );
    }
  }
}
