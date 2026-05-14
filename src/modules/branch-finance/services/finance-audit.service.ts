import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

/**
 * Append-only finance audit trail for balance confirmations, recalculations, and corrections.
 */
@Injectable()
export class FinanceAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    branchId?: string | null;
    userId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
    transactionId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.prisma.finance_audit_events.create({
      data: {
        branch_id: params.branchId ?? undefined,
        user_id: params.userId ?? undefined,
        event_type: params.eventType,
        payload: params.payload as Prisma.InputJsonValue,
        transaction_id: params.transactionId ?? undefined,
        ip_address: params.ipAddress ?? undefined,
        user_agent: params.userAgent ?? undefined,
      },
    });
  }
}
