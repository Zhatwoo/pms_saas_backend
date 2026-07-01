import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';

@Injectable()
export class OpeningChecklistGateService {
  constructor(private readonly prisma: PrismaService) {}

  private toRecordDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  /**
   * True when branch staff may use checklist-gated modules for today's Manila session.
   * Matches branch day session + daily_opening rules used by the opening checklist UI.
   */
  async isModulesAllowed(
    branchId: string,
    actorUserId?: string | null,
  ): Promise<boolean> {
    const todayStr = getPhCalendarDateString();
    const openingDate = this.toRecordDate(todayStr);

    const [opening, daySession] = await Promise.all([
      this.prisma.daily_opening.findUnique({
        where: {
          branch_id_opening_date: {
            branch_id: branchId,
            opening_date: openingDate,
          },
        },
        select: { status: true },
      }),
      this.prisma.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: branchId,
            session_date: openingDate,
          },
        },
        select: { is_closed: true },
      }),
    ]);

    /** End Day closes the branch session — staff must Start Day again even if daily_opening still exists. */
    if (daySession?.is_closed === true) {
      return false;
    }

    /** Starting cash done but inventory audit not yet submitted. */
    if (opening?.status === 'pending') {
      return false;
    }

    if (daySession && !daySession.is_closed) {
      return true;
    }

    if (opening?.status === 'completed') {
      return true;
    }

    const pawnCount = await this.prisma.pawned_items.count({
      where: { branch_id: branchId },
    });

    if (pawnCount === 0) {
      await this.prisma.daily_opening.upsert({
        where: {
          branch_id_opening_date: {
            branch_id: branchId,
            opening_date: openingDate,
          },
        },
        create: {
          branch_id: branchId,
          opening_date: openingDate,
          starting_cash: 0,
          status: 'completed',
          employee_id: actorUserId ?? null,
          last_updated_by_user_id: actorUserId ?? null,
        },
        update: {
          status: 'completed',
          last_updated_by_user_id: actorUserId ?? null,
          updated_at: new Date(),
        },
      });
      return true;
    }

    return false;
  }

  /**
   * True during INVENTORY_AUDIT (starting cash submitted, audit not yet completed).
   * Lets inventory checklist/tally APIs run while other modules stay gated.
   */
  async isInventoryAuditAllowed(branchId: string): Promise<boolean> {
    const todayStr = getPhCalendarDateString();
    const openingDate = this.toRecordDate(todayStr);

    const [opening, daySession] = await Promise.all([
      this.prisma.daily_opening.findUnique({
        where: {
          branch_id_opening_date: {
            branch_id: branchId,
            opening_date: openingDate,
          },
        },
        select: { status: true },
      }),
      this.prisma.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: branchId,
            session_date: openingDate,
          },
        },
        select: { is_closed: true },
      }),
    ]);

    if (daySession?.is_closed === true) {
      return false;
    }

    return opening?.status === 'pending';
  }
}
