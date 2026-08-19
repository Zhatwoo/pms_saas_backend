import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../common/enums';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../infrastructure/supabase/supabase.service';
import {
  canEditIncidentTicketContent,
  creatorAttemptedManagementUpdate,
  hasCreatorContentUpdate,
  isIncidentTicketManager,
} from './incident-ticket-permissions.util';
import {
  buildIncidentEditHistory,
  type IncidentTicketContentSnapshot,
} from './incident-ticket-edit-history.util';

interface CreateIncidentTicketDto {
  title?: string;
  summary?: string;
  category?: string;
  priority?: string;
  branchId?: string;
  userId?: string | null;
  amountImpact?: number | null;
  transactionRef?: string | null;
  inventoryItemRef?: string | null;
  itemStatus?: 'missing' | 'broken' | 'damaged' | null;
  metadata?: Record<string, unknown>;
  requiresManagerEscalation?: boolean;
  escalationOwnerUserId?: string | null;
}

interface UpdateIncidentTicketDto {
  title?: string;
  summary?: string;
  category?: string;
  priority?: string;
  amountImpact?: number | null;
  transactionRef?: string | null;
  status?: string;
  requiresManagerEscalation?: boolean;
  escalationOwnerUserId?: string | null;
  resolutionNotes?: string | null;
}

export interface RaiseIncidentTicketResult {
  id: string;
  [key: string]: unknown;
}

interface IncidentTicketRow {
  id: string;
  branch_id: string;
  status: string;
  reported_by_user_id: string | null;
  escalation_owner_user_id: string | null;
  title?: string;
  summary?: string;
  category?: string;
  priority?: string;
  amount_impact?: number | null;
  transaction_ref?: string | null;
  [key: string]: unknown;
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
    | 'reopened'
    | 'updated';
  actorUserId?: string | null;
  subjectUserId?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class IncidentTicketsService {
  private readonly logger = new Logger(IncidentTicketsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  private ensureBranchAccess(user: AuthenticatedUserProfile, branchId: string) {
    if (user.role === Role.SUPER_ADMIN) return;
    if (!user.branchId || user.branchId !== branchId) {
      throw new ForbiddenException(
        'You cannot access incident tickets for this branch.',
      );
    }
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

    let escalationOwnerUserId: string | null = null;
    if (dto.requiresManagerEscalation) {
      if (dto.escalationOwnerUserId) {
        await this.ensureAssigneeAccess(user, branchId, dto.escalationOwnerUserId);
        escalationOwnerUserId = dto.escalationOwnerUserId;
      } else {
        escalationOwnerUserId = await this.resolveManagerId(branchId);
      }
    }

    const rpcResult: {
      data: RaiseIncidentTicketResult | null;
      error: unknown;
    } = await this.supabaseService.getClient().rpc('raise_incident_ticket', {
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
      p_inventory_item_ref: dto.inventoryItemRef?.trim() || null,
      p_amount_impact:
        typeof dto.amountImpact === 'number' &&
        Number.isFinite(dto.amountImpact)
          ? dto.amountImpact
          : null,
      p_requires_manager_escalation: Boolean(dto.requiresManagerEscalation),
      p_status: dto.requiresManagerEscalation ? 'escalated' : 'open',
      p_metadata: {
        created_from: 'backend-incident-tickets-api',
        ...(dto.metadata ?? {}),
        itemStatus: dto.itemStatus ?? null,
      },
    });
    const data: RaiseIncidentTicketResult | null = rpcResult.data;
    const error: unknown = rpcResult.error;

    if (error) {
      const message = this.extractErrorMessage(error);
      this.logger.error(`Failed to create incident ticket: ${message}`);
      throw new InternalServerErrorException(
        message || 'Failed to create incident ticket',
      );
    }

    if (data?.id) {
      await this.recordEvent({
        ticketId: data.id,
        branchId,
        action: 'reported',
        actorUserId: user.id,
        subjectUserId: dto.userId || user.id,
        notes: dto.summary.trim(),
      });

      if (escalationOwnerUserId) {
        await this.recordEvent({
          ticketId: data.id,
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

    const {
      data: existing,
      error: fetchError,
    }: {
      data: Pick<
        IncidentTicketRow,
        | 'id'
        | 'branch_id'
        | 'status'
        | 'reported_by_user_id'
        | 'escalation_owner_user_id'
        | 'title'
        | 'summary'
        | 'category'
        | 'priority'
        | 'amount_impact'
        | 'transaction_ref'
      > | null;
      error: unknown;
    } = await client
      .from('incident_tickets')
      .select(
        'id, branch_id, status, reported_by_user_id, escalation_owner_user_id, title, summary, category, priority, amount_impact, transaction_ref',
      )
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      this.logger.error(
        `Failed to fetch incident ticket ${id}: ${this.extractErrorMessage(fetchError)}`,
      );
      throw new InternalServerErrorException('Failed to load incident ticket');
    }

    if (!existing) {
      throw new NotFoundException('Incident ticket not found');
    }

    this.ensureBranchAccess(user, existing.branch_id);

    const isManager = isIncidentTicketManager(user.role as Role);
    const canEditContent = canEditIncidentTicketContent(existing, user.id);

    if (!isManager) {
      if (!canEditContent) {
        throw new ForbiddenException(
          'You can only edit incident tickets you created or are assigned to.',
        );
      }

      if (creatorAttemptedManagementUpdate(dto)) {
        throw new ForbiddenException(
          'You can only update ticket details for tickets you created.',
        );
      }

      if (!hasCreatorContentUpdate(dto)) {
        throw new BadRequestException('No ticket details were provided to update.');
      }

      const patch = this.buildCreatorContentPatch(dto);
      const events = this.buildContentUpdateEvents(user.id, id, existing, patch);
      return this.applyIncidentTicketPatch(user, id, existing, patch, events, false);
    }

    if (hasCreatorContentUpdate(dto) && !canEditContent) {
      throw new ForbiddenException(
        'You can only edit incident tickets you created or are assigned to.',
      );
    }

    const patch: Record<string, unknown> = {};
    const events: IncidentTicketEventPayload[] = [];

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) {
        throw new BadRequestException('Title is required.');
      }
      patch.title = title;
    }

    if (dto.summary !== undefined) {
      const summary = dto.summary.trim();
      if (!summary) {
        throw new BadRequestException('Summary is required.');
      }
      patch.summary = summary;
    }

    if (dto.category !== undefined) {
      const category = dto.category.trim();
      if (!category) {
        throw new BadRequestException('Category is required.');
      }
      patch.category = category;
    }

    if (dto.priority !== undefined) {
      patch.priority = dto.priority;
    }

    if (dto.amountImpact !== undefined) {
      patch.amount_impact =
        typeof dto.amountImpact === 'number' &&
        Number.isFinite(dto.amountImpact)
          ? dto.amountImpact
          : null;
    }

    if (dto.transactionRef !== undefined) {
      patch.transaction_ref = dto.transactionRef?.trim() || null;
    }

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

    const contentUpdateEvents = this.buildContentUpdateEvents(
      user.id,
      id,
      existing,
      patch,
    );
    events.push(...contentUpdateEvents);

    return this.applyIncidentTicketPatch(user, id, existing, patch, events, false);
  }

  private toContentSnapshot(
    ticket: Pick<
      IncidentTicketRow,
      | 'title'
      | 'summary'
      | 'category'
      | 'priority'
      | 'amount_impact'
      | 'transaction_ref'
    >,
  ): IncidentTicketContentSnapshot {
    return {
      title: String(ticket.title ?? ''),
      summary: String(ticket.summary ?? ''),
      category: String(ticket.category ?? ''),
      priority: String(ticket.priority ?? ''),
      amount_impact:
        typeof ticket.amount_impact === 'number' ? ticket.amount_impact : null,
      transaction_ref: ticket.transaction_ref ?? null,
    };
  }

  private buildContentUpdateEvents(
    actorUserId: string,
    ticketId: string,
    existing: Pick<
      IncidentTicketRow,
      | 'branch_id'
      | 'title'
      | 'summary'
      | 'category'
      | 'priority'
      | 'amount_impact'
      | 'transaction_ref'
    >,
    patch: Record<string, unknown>,
  ): IncidentTicketEventPayload[] {
    const history = buildIncidentEditHistory(
      this.toContentSnapshot(existing),
      patch,
    );

    if (!history) return [];

    return [
      {
        ticketId,
        branchId: existing.branch_id,
        action: 'updated',
        actorUserId,
        notes: history.notes,
        metadata: { changedFields: history.changedFields },
      },
    ];
  }

  private buildCreatorContentPatch(
    dto: UpdateIncidentTicketDto,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) {
        throw new BadRequestException('Title is required.');
      }
      patch.title = title;
    }

    if (dto.summary !== undefined) {
      const summary = dto.summary.trim();
      if (!summary) {
        throw new BadRequestException('Summary is required.');
      }
      patch.summary = summary;
    }

    if (dto.category !== undefined) {
      const category = dto.category.trim();
      if (!category) {
        throw new BadRequestException('Category is required.');
      }
      patch.category = category;
    }

    if (dto.priority !== undefined) {
      patch.priority = dto.priority;
    }

    if (dto.amountImpact !== undefined) {
      patch.amount_impact =
        typeof dto.amountImpact === 'number' &&
        Number.isFinite(dto.amountImpact)
          ? dto.amountImpact
          : null;
    }

    if (dto.transactionRef !== undefined) {
      patch.transaction_ref = dto.transactionRef?.trim() || null;
    }

    return patch;
  }

  private mapPatchToPrismaData(
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    if (patch.title !== undefined) data.title = patch.title;
    if (patch.summary !== undefined) data.summary = patch.summary;
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.amount_impact !== undefined) data.amount_impact = patch.amount_impact;
    if (patch.transaction_ref !== undefined) {
      data.transaction_ref = patch.transaction_ref;
    }
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.resolved_by !== undefined) data.resolved_by = patch.resolved_by;
    if (patch.resolved_at !== undefined) data.resolved_at = patch.resolved_at;
    if (patch.resolution_notes !== undefined) {
      data.resolution_notes = patch.resolution_notes;
    }
    if (patch.reopened_at !== undefined) data.reopened_at = patch.reopened_at;
    if (patch.requires_manager_escalation !== undefined) {
      data.requires_manager_escalation = patch.requires_manager_escalation;
    }
    if (patch.escalation_owner_user_id !== undefined) {
      data.escalation_owner_user_id = patch.escalation_owner_user_id;
    }

    data.updated_at = new Date();
    return data;
  }

  private async applyIncidentTicketPatch(
    user: AuthenticatedUserProfile,
    id: string,
    existing: Pick<IncidentTicketRow, 'branch_id' | 'escalation_owner_user_id'>,
    dto: UpdateIncidentTicketDto | Record<string, unknown>,
    events: IncidentTicketEventPayload[],
    creatorOnly: boolean,
  ) {
    const client = this.supabaseService.getClient();
    const patch = creatorOnly
      ? this.buildCreatorContentPatch(dto as UpdateIncidentTicketDto)
      : (dto as Record<string, unknown>);

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No ticket updates were provided.');
    }

    try {
      await this.prisma.incident_tickets.update({
        where: { id },
        data: this.mapPatchToPrismaData(patch) as never,
      });
    } catch (error) {
      this.logger.error(
        `Failed to update incident ticket ${id}: ${this.extractErrorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        'Failed to update incident ticket',
      );
    }

    const {
      data,
      error,
    }: { data: Record<string, unknown> | null; error: unknown } = await client
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
      .eq('id', id)
      .maybeSingle();

    if (error) {
      this.logger.error(
        `Failed to load updated incident ticket ${id}: ${this.extractErrorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        'Failed to load updated incident ticket',
      );
    }

    for (const event of events) {
      await this.recordEvent(event);
    }

    return data;
  }

  private async resolveManagerId(branchId: string) {
    const data = await this.prisma.users.findFirst({
      where: {
        branch_id: branchId,
        role: Role.ADMIN,
      },
      select: { id: true },
    });

    return data?.id ?? null;
  }

  private async ensureAssigneeAccess(
    user: AuthenticatedUserProfile,
    ticketBranchId: string,
    assigneeId?: string | null,
  ) {
    if (!assigneeId) return;

    const data = await this.prisma.users.findUnique({
      where: { id: assigneeId },
      select: {
        id: true,
        role: true,
        branch_id: true,
      },
    });

    if (!data) {
      throw new BadRequestException('Selected assignee was not found.');
    }

    if (
      data.role !== (Role.ADMIN as string) ||
      data.branch_id !== ticketBranchId
    ) {
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

  private extractErrorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return 'Unknown error';
  }
}
