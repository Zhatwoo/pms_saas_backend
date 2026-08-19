import { Role } from '../../common/enums';

export interface IncidentTicketOwnership {
  reported_by_user_id: string | null;
  escalation_owner_user_id?: string | null;
  status: string;
}

export interface IncidentCreatorUpdateInput {
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

export function isIncidentTicketManager(role: Role): boolean {
  return role === Role.SUPER_ADMIN || role === Role.ADMIN;
}

export function canCreatorEditIncidentTicket(
  ticket: IncidentTicketOwnership,
  userId: string,
): boolean {
  return ticket.reported_by_user_id === userId && ticket.status !== 'resolved';
}

export function canEditIncidentTicketContent(
  ticket: IncidentTicketOwnership,
  userId: string,
): boolean {
  if (ticket.status === 'resolved') return false;
  if (ticket.reported_by_user_id === userId) return true;
  return ticket.escalation_owner_user_id === userId;
}

export function creatorAttemptedManagementUpdate(
  dto: IncidentCreatorUpdateInput,
): boolean {
  return (
    dto.status !== undefined ||
    dto.requiresManagerEscalation !== undefined ||
    dto.escalationOwnerUserId !== undefined ||
    dto.resolutionNotes !== undefined
  );
}

export function hasCreatorContentUpdate(
  dto: IncidentCreatorUpdateInput,
): boolean {
  return (
    dto.title !== undefined ||
    dto.summary !== undefined ||
    dto.category !== undefined ||
    dto.priority !== undefined ||
    dto.amountImpact !== undefined ||
    dto.transactionRef !== undefined
  );
}
