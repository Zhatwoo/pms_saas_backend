import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addManilaCalendarDays } from '../../../common/utils/branch-calendar-date.util';
import { TransactionPurpose } from '../../../common/enums';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  isInboundBranchCashFundTransferRow,
  isJournalPurposeStartEnd,
  operationalNetFromRows,
} from '../utils/finance-ledger.util';
import { BranchFinanceSessionGateService } from './branch-finance-session-gate.service';

export type FinanceDailyBalanceTx = any;
type Tx = FinanceDailyBalanceTx;

/**
 * Single writer for daily_balances: locked reads, Decimal math, branch opening capital fallback.
 * All cash-affecting modules must call applyNetChange (or confirmation helpers) instead of ad hoc Supabase updates.
 * Operational postings require an open branch_day_sessions Manila calendar row unless callers bypass the gate explicitly.
 */
@Injectable()
export class FinanceDailyBalanceService {
  private readonly logger = new Logger(FinanceDailyBalanceService.name);

  private get db(): any {
    return this.prisma as any;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sessionGate: BranchFinanceSessionGateService,
  ) {}

  private toRecordDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  private dec(n: unknown): number {
    const value = Number(String(n ?? 0));
    return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
  }

  /**
   * When true, projected ending may go below zero (no INSUFFICIENT_FUNDS) for operational postings.
   * Defaults to ON; set `security.allowNegativeBranchCashBalance=false` for strict non-negative cash.
   * End-of-day reconciliation always bypasses this check separately (see `skipInsufficientFundsCheck`).
   */
  private allowNegativeEnding(): boolean {
    const raw = this.config.get<boolean | string | undefined>(
      'security.allowNegativeBranchCashBalance',
    );
    if (raw === false || raw === 'false' || raw === '0') {
      return false;
    }
    return true;
  }

  /**
   * Ledger ending after applying net cash delta (cash_in − cash_out) for the Manila business date.
   * Locks daily_balances row when present; uses prior day / session / branch opening fallback when missing.
   */
  private async projectEndingAfterDeltaInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
    delta: number,
    options?: { bypassOperationalSessionGate?: boolean },
  ): Promise<{
    baseline: number;
    next: number;
    existingRow: { id: string } | null;
    carriedForCreate: number;
  }> {
    if (!options?.bypassOperationalSessionGate) {
      await this.sessionGate.assertOperationalPostingAllowed(
        client,
        branchId,
        businessDateStr,
      );
    }

    const date = this.toRecordDate(businessDateStr);

    await client.$executeRaw`
        SELECT id FROM daily_balances
        WHERE branch_id = ${branchId}::uuid AND record_date = ${date}::date
        FOR UPDATE
      `;

    const { baseline, carriedForCreate } = await this.resolveCurrentBookBalanceInTx(
      client,
      branchId,
      businessDateStr,
    );

    const current = await client.daily_balances.findUnique({
      where: {
        branch_id_record_date: { branch_id: branchId, record_date: date },
      },
      select: { id: true },
    });

    return {
      baseline,
      next: Number((baseline + delta).toFixed(2)),
      existingRow: current ? { id: current.id } : null,
      carriedForCreate,
    };
  }

  private throwIfNegativeEnding(
    next: number,
    ctx: {
      branchId: string;
      businessDateStr: string;
      baselineBeforeDelta: number;
      netChangeDecimal: number;
      /** When set (e.g. reconciliation), overrides gross delta for `required_amount` in the API payload. */
      requiredAmountOverride?: number;
    },
    opts?: { skipInsufficientFundsCheck?: boolean },
  ): void {
    if (opts?.skipInsufficientFundsCheck) {
      return;
    }
    if (this.allowNegativeEnding() || !(next < 0)) {
      return;
    }

    const available_balance = Number(ctx.baselineBeforeDelta.toFixed(2));
    const required_amount =
      ctx.requiredAmountOverride ?? Math.abs(ctx.netChangeDecimal);

    this.logger.warn(
      `[BranchCash] INSUFFICIENT_FUNDS branchId=${ctx.branchId} businessDate=${ctx.businessDateStr} available_balance=${available_balance} required_amount=${required_amount} netDelta=${ctx.netChangeDecimal} projectedEnding=${next} ts=${new Date().toISOString()}`,
    );

    throw new HttpException(
      {
        error: 'INSUFFICIENT_FUNDS',
        message: 'Branch cash is not enough',
        available_balance,
        required_amount,
        branch_id: ctx.branchId,
        business_date: ctx.businessDateStr,
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Validates that applying netChange would not drive ending balance negative, without writing.
   * Call at the start of a DB transaction before creating dependent rows (e.g. pawn ticket).
   */
  async assertNetChangePermittedInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
    netChange: number,
  ): Promise<void> {
    if (!branchId || !Number.isFinite(netChange) || netChange === 0) {
      return;
    }
    const delta = Number(netChange.toFixed(2));
    const { baseline, next } = await this.projectEndingAfterDeltaInTx(
      client,
      branchId,
      businessDateStr,
      delta,
    );
    this.throwIfNegativeEnding(
      next,
      {
        branchId,
        businessDateStr,
        baselineBeforeDelta: baseline,
        netChangeDecimal: delta,
      },
      undefined,
    );
  }

  /**
   * Drops inbound fund-transfer journal lines that belong to a fund_requests row on this branch
   * that is not yet receipt-confirmed (`status !== transferred`), so orphan or in-flight postings
   * do not move book cash until confirm succeeds.
   */
  async excludeInboundFundTransfersAwaitingReceiptRows<
    T extends {
      branch_id?: string | null;
      purpose?: string | null;
      unit?: string | null;
      unit_code?: string | null;
      cash_in?: unknown;
      cash_out?: unknown;
      voided_at?: Date | string | null;
    },
  >(
    rows: T[],
    pendingLinksByBranch?: Map<string, Set<string>>,
  ): Promise<T[]> {
    const branchIds = [
      ...new Set(
        rows
          .map((r) => r.branch_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (branchIds.length === 0) {
      return rows;
    }

    let pendingByBranch = pendingLinksByBranch;
    if (!pendingByBranch) {
      const pendingLinks = await this.db.fund_requests.findMany({
        where: {
          branch_id: { in: branchIds },
          status: { not: 'transferred' },
        },
        select: { branch_id: true, request_no: true },
      });
      pendingByBranch = new Map<string, Set<string>>();
      for (const link of pendingLinks) {
        if (!pendingByBranch.has(link.branch_id)) {
          pendingByBranch.set(link.branch_id, new Set());
        }
        pendingByBranch.get(link.branch_id)!.add(link.request_no);
      }
    }
    if (pendingByBranch.size === 0) {
      return rows;
    }

    return rows.filter((r) => {
      const bid = r.branch_id;
      if (!bid || !isInboundBranchCashFundTransferRow(r)) {
        return true;
      }
      const code = (r.unit_code ?? '').trim();
      if (!code) {
        return true;
      }
      return !pendingByBranch.get(bid)?.has(code);
    });
  }

  private txCreatedAtMs(value: Date | string | null | undefined): number {
    if (value == null) return 0;
    if (value instanceof Date) return value.getTime();
    const t = new Date(String(value)).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  private markerTimestampMs(marker: {
    updated_at?: Date | string | null;
    created_at?: Date | string | null;
  }): number {
    return Math.max(
      this.txCreatedAtMs(marker.updated_at),
      this.txCreatedAtMs(marker.created_at),
    );
  }

  /**
   * Earliest instant for operational cash in the **current** open shift.
   * max(operational_cutoff_at, opened_at, latest Start journal, latest End journal).
   */
  async resolveOperationalCutoffMs(
    branchId: string,
    sessionDate: Date,
    client: PrismaService | Tx = this.db,
  ): Promise<number> {
    const daySession = await client.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: sessionDate,
        },
      },
      select: {
        opened_at: true,
        operational_cutoff_at: true,
      },
    });

    let cutoffMs = 0;
    if (daySession?.operational_cutoff_at) {
      cutoffMs = daySession.operational_cutoff_at.getTime();
    }
    if (daySession?.opened_at) {
      cutoffMs = Math.max(cutoffMs, daySession.opened_at.getTime());
    }

    const journalWhere = {
      branch_id: branchId,
      transaction_date: sessionDate,
      voided_at: null,
    } as const;

    const [lastStartMarker, lastEndMarker] = await Promise.all([
      client.transactions.findFirst({
        where: { ...journalWhere, purpose: TransactionPurpose.START },
        orderBy: { updated_at: 'desc' },
        select: { updated_at: true, created_at: true },
      }),
      client.transactions.findFirst({
        where: { ...journalWhere, purpose: TransactionPurpose.END },
        orderBy: { updated_at: 'desc' },
        select: { updated_at: true, created_at: true },
      }),
    ]);

    for (const marker of [lastStartMarker, lastEndMarker]) {
      if (!marker) continue;
      cutoffMs = Math.max(cutoffMs, this.markerTimestampMs(marker));
    }

    return cutoffMs;
  }

  /**
   * Book balance for applyNetChange when today's branch_day_sessions row is open:
   * confirmed session start + operational net since {@link resolveOperationalCutoffMs}
   * (never a stale daily_balances.ending_balance from a prior shift).
   */
  private async resolveCurrentBookBalanceInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
  ): Promise<{ baseline: number; carriedForCreate: number }> {
    const date = this.toRecordDate(businessDateStr);
    const session = await client.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: date,
        },
      },
      select: { starting_balance: true, is_closed: true },
    });

    if (session && !session.is_closed && session.starting_balance != null) {
      const start = this.dec(session.starting_balance);
      const net = await this.sumOperationalNetCashInTx(
        client,
        branchId,
        businessDateStr,
      );
      return {
        baseline: Number((start + net).toFixed(2)),
        carriedForCreate: start,
      };
    }

    const current = await client.daily_balances.findUnique({
      where: {
        branch_id_record_date: { branch_id: branchId, record_date: date },
      },
      select: { ending_balance: true, starting_balance: true },
    });

    if (current) {
      const ending = this.dec(current.ending_balance);
      const starting = this.dec(current.starting_balance);
      return {
        baseline: ending,
        carriedForCreate: starting > 0 ? starting : ending,
      };
    }

    const prior = await client.daily_balances.findFirst({
      where: { branch_id: branchId, record_date: { lt: date } },
      orderBy: { record_date: 'desc' },
      select: { ending_balance: true },
    });
    const branch = await client.branches.findUnique({
      where: { id: branchId },
      select: { opening_cash_balance: true },
    });

    const carried = prior
      ? this.dec(prior.ending_balance)
      : this.dec(branch?.opening_cash_balance);
    return { baseline: carried, carriedForCreate: carried };
  }

  async resolveOperationalCutoffIso(
    branchId: string,
    businessDateStr: string,
    client?: PrismaService | Tx,
  ): Promise<string | null> {
    const ms = await this.resolveOperationalCutoffMs(
      branchId,
      this.toRecordDate(businessDateStr),
      client ?? this.db,
    );
    return ms > 0 ? new Date(ms).toISOString() : null;
  }

  /**
   * Inbound fund-transfer cash posted before the branch day is "opened" (starting balance submitted)
   * is already inside the employee's physical starting count — do not add it again in operational net.
   *
   * Rows before {@link resolveOperationalCutoffMs} are excluded (prior employee shift same Manila day).
   *
   * When persisting starting balance (`forStartingPersist`), operational net is always zero: the
   * confirmed physical count already includes all cash on hand; same-day ops accrue only after open.
   */
  private async finalizeRowsForOperationalNet<
    T extends {
      id?: string;
      branch_id?: string | null;
      purpose?: string | null;
      unit?: string | null;
      unit_code?: string | null;
      cash_in?: unknown;
      cash_out?: unknown;
      voided_at?: Date | string | null;
      created_at?: Date | string | null;
    },
  >(
    rows: T[],
    branchId: string,
    sessionDate: Date,
    client: PrismaService | Tx,
    opts?: { forStartingPersist?: boolean },
  ): Promise<T[]> {
    const out = await this.excludeInboundFundTransfersAwaitingReceiptRows(rows);
    if (opts?.forStartingPersist) {
      return [];
    }

    const cutoffMs = await this.resolveOperationalCutoffMs(
      branchId,
      sessionDate,
      client,
    );

    const daySession = await client.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: sessionDate,
        },
      },
      select: { sealed_transaction_ids: true },
    });
    const sealed = new Set(daySession?.sealed_transaction_ids ?? []);

    return out.filter((r) => {
      if (r.id && sealed.has(r.id)) {
        return false;
      }
      if (cutoffMs <= 0) {
        return true;
      }
      return this.txCreatedAtMs(r.created_at) >= cutoffMs;
    });
  }

  /** Operational tx ids posted strictly before the shift cutoff (prior shift, same Manila day). */
  async listOperationalTransactionIdsSealedBeforeCutoffInTx(
    client: Tx,
    branchId: string,
    sessionDate: Date,
    cutoff: Date,
  ): Promise<string[]> {
    const cutoffMs = cutoff.getTime();
    const rows = await client.transactions.findMany({
      where: {
        branch_id: branchId,
        transaction_date: sessionDate,
        voided_at: null,
      },
      select: { id: true, purpose: true, created_at: true },
    });
    return rows
      .filter(
        (r) =>
          !isJournalPurposeStartEnd(r.purpose) &&
          this.txCreatedAtMs(r.created_at) < cutoffMs,
      )
      .map((r) => r.id);
  }

  /** Operational cash movement for a Manila business date (excludes Start/End markers and voided rows). */
  async sumOperationalNetCash(
    branchId: string,
    businessDateStr: string,
    opts?: { forStartingPersist?: boolean },
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const rows = await this.db.transactions.findMany({
      where: { branch_id: branchId, transaction_date: date, voided_at: null },
      select: {
        id: true,
        branch_id: true,
        purpose: true,
        unit: true,
        unit_code: true,
        cash_in: true,
        cash_out: true,
        created_at: true,
      },
    });
    const filtered = await this.finalizeRowsForOperationalNet(
      rows,
      branchId,
      date,
      this.prisma,
      opts,
    );
    return Number(operationalNetFromRows(filtered).toFixed(2));
  }

  /**
   * Book cash position at end of a Manila calendar day (for suggested next-day opening count).
   * = that day's stored starting (employee-confirmed when row exists, else branch opening capital)
   * + same-day operational net (cash_in − cash_out, excluding Start/End & voided).
   * Matches ledger; fund transfers recorded as operational rows on that date are included.
   */
  async ledgerBookEndingForBusinessDate(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const daySession = await this.db.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: date,
        },
      },
      select: { starting_balance: true, is_closed: true },
    });
    const row = await this.db.daily_balances.findUnique({
      where: {
        branch_id_record_date: { branch_id: branchId, record_date: date },
      },
      select: { starting_balance: true },
    });
    const net = await this.sumOperationalNetCash(branchId, businessDateStr);
    let start: number;
    if (
      daySession &&
      !daySession.is_closed &&
      daySession.starting_balance != null
    ) {
      start = Number(this.dec(daySession.starting_balance).toFixed(2));
    } else if (row) {
      start = Number(this.dec(row.starting_balance).toFixed(2));
    } else {
      const b = await this.db.branches.findUnique({
        where: { id: branchId },
        select: { opening_cash_balance: true },
      });
      start = Number(this.dec(b?.opening_cash_balance).toFixed(2));
    }
    return Number((start + net).toFixed(2));
  }

  /**
   * @see suggestedStartingCashForBusinessDate — also returns which closed session date the amount came from.
   */
  async suggestedStartingBasisForBusinessDate(
    branchId: string,
    businessDateStr: string,
  ): Promise<{ amount: number; closedSessionRecordDate: string | null }> {
    const bizDate = this.toRecordDate(businessDateStr);

    const lastClosed = await this.db.branch_day_sessions.findFirst({
      where: {
        branch_id: branchId,
        is_closed: true,
        session_date: { lte: bizDate },
      },
      // `closed_at` may be null on legacy rows; `is_closed` is authoritative for inclusion.
      orderBy: [{ session_date: 'desc' }, { closed_at: 'desc' }],
      select: { session_date: true },
    });

    if (lastClosed) {
      const sessionDateStr = lastClosed.session_date
        .toISOString()
        .slice(0, 10);
      const recordDate = this.toRecordDate(sessionDateStr);

      const bal = await this.db.daily_balances.findUnique({
        where: {
          branch_id_record_date: {
            branch_id: branchId,
            record_date: recordDate,
          },
        },
        select: { ending_balance: true },
      });
      if (bal?.ending_balance != null) {
        return {
          amount: Number(this.dec(bal.ending_balance).toFixed(2)),
          closedSessionRecordDate: sessionDateStr,
        };
      }

      const ledgerOnCloseDay = Number(
        (
          await this.ledgerBookEndingForBusinessDate(
            branchId,
            sessionDateStr,
          )
        ).toFixed(2),
      );
      return {
        amount: ledgerOnCloseDay,
        closedSessionRecordDate: sessionDateStr,
      };
    }

    const branchRow = await this.db.branches.findUnique({
      where: { id: branchId },
      select: { opening_cash_balance: true },
    });
    const openingCapital = Number(
      this.dec(branchRow?.opening_cash_balance).toFixed(2),
    );
    const priorStr = addManilaCalendarDays(businessDateStr, -1);
    const ledgerPrior = Number(
      (
        await this.ledgerBookEndingForBusinessDate(branchId, priorStr)
      ).toFixed(2),
    );
    return {
      amount: Math.max(openingCapital, ledgerPrior),
      closedSessionRecordDate: null,
    };
  }

  /**
   * Expected physical count when opening `businessDateStr` (Manila): the **book ending** from the
   * most recent closed `branch_day_sessions` row with `session_date <=` that date — i.e. what End Day
   * persisted on `daily_balances` for that session date. Not `Math.max` with older rows (that showed
   * yesterday’s 1500 over today’s closed 1200).
   *
   * If no closed session yet: `opening_cash_balance` vs prior-day ledger ending (first-day fallback).
   */
  async suggestedStartingCashForBusinessDate(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const { amount } = await this.suggestedStartingBasisForBusinessDate(
      branchId,
      businessDateStr,
    );
    return amount;
  }

  async sumOperationalNetCashInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
    opts?: { forStartingPersist?: boolean },
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const rows = await client.transactions.findMany({
      where: { branch_id: branchId, transaction_date: date, voided_at: null },
      select: {
        id: true,
        branch_id: true,
        purpose: true,
        unit: true,
        unit_code: true,
        cash_in: true,
        cash_out: true,
        created_at: true,
      },
    });
    const filtered = await this.finalizeRowsForOperationalNet(
      rows,
      branchId,
      date,
      client,
      opts,
    );
    return Number(operationalNetFromRows(filtered).toFixed(2));
  }

  /**
   * Align `daily_balances` with open `branch_day_sessions` book (confirmed start + net since cutoff).
   * Repairs stale starting/ending left from a prior shift on the same Manila date.
   */
  async reconcileOpenSessionDailyBalance(
    branchId: string,
    businessDateStr: string,
    existingClient?: Tx,
  ): Promise<void> {
    const run = async (client: Tx) => {
      const date = this.toRecordDate(businessDateStr);
      const session = await client.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: branchId,
            session_date: date,
          },
        },
        select: {
          id: true,
          starting_balance: true,
          is_closed: true,
          operational_cutoff_at: true,
          sealed_transaction_ids: true,
        },
      });
      if (!session || session.is_closed || session.starting_balance == null) {
        return;
      }

      const cutoffMs = await this.resolveOperationalCutoffMs(
        branchId,
        date,
        client,
      );
      const cutoffDate = new Date(cutoffMs > 0 ? cutoffMs : Date.now());
      const sealedIds =
        await this.listOperationalTransactionIdsSealedBeforeCutoffInTx(
          client,
          branchId,
          date,
          cutoffDate,
        );

      await client.branch_day_sessions.update({
        where: { id: session.id },
        data: {
          sealed_transaction_ids: sealedIds,
          operational_cutoff_at: cutoffDate,
          updated_at: new Date(),
        },
      });

      const starting = this.dec(session.starting_balance);
      const net = await this.sumOperationalNetCashInTx(
        client,
        branchId,
        businessDateStr,
      );
      const ending = Number((starting + net).toFixed(2));

      await client.daily_balances.upsert({
        where: {
          branch_id_record_date: {
            branch_id: branchId,
            record_date: date,
          },
        },
        create: {
          branch_id: branchId,
          record_date: date,
          starting_balance: starting,
          ending_balance: ending,
        },
        update: {
          starting_balance: starting,
          ending_balance: ending,
          updated_at: new Date(),
        },
      });
    };

    if (existingClient) {
      await run(existingClient);
      return;
    }
    await this.db.$transaction(run);
  }

  /**
   * Apply cash delta to ending_balance for the branch business day. Creates today's row with carry-forward
   * (prior ending or branches.opening_cash_balance) when missing.
   * Use `bypassOperationalSessionGate` only for controlled flows (e.g. fund transfer confirmation).
   */
  async applyNetChange(
    branchId: string | undefined,
    businessDateStr: string,
    netChange: number,
    tx?: Tx,
    options?: { bypassOperationalSessionGate?: boolean },
  ): Promise<void> {
    if (!branchId || !Number.isFinite(netChange) || netChange === 0) {
      return;
    }
    const delta = Number(netChange.toFixed(2));
    const date = this.toRecordDate(businessDateStr);

    const run = async (client: Tx) => {
      const { baseline, next, existingRow, carriedForCreate } =
        await this.projectEndingAfterDeltaInTx(
          client,
          branchId,
          businessDateStr,
          delta,
          options,
        );

      this.throwIfNegativeEnding(
        next,
        {
          branchId,
          businessDateStr,
          baselineBeforeDelta: baseline,
          netChangeDecimal: delta,
        },
        undefined,
      );

      if (existingRow) {
        await client.daily_balances.update({
          where: { id: existingRow.id },
          data: { ending_balance: next, updated_at: new Date() },
        });
        return;
      }

      await client.daily_balances.create({
        data: {
          branch_id: branchId,
          record_date: date,
          starting_balance: carriedForCreate,
          ending_balance: next,
        },
      });
    };

    if (tx) {
      await run(tx);
      return;
    }

    await this.db.$transaction(run, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: 'ReadCommitted' as any,
    });
  }

  /**
   * Persist starting/ending balances inside an existing transaction (caller holds locks / orchestrates session).
   */
  async persistConfirmationBalancesInTx(
    client: Tx,
    params: {
      branchId: string;
      businessDateStr: string;
      mode: 'starting' | 'ending';
      confirmedAmount: number;
    },
  ): Promise<{ startingBalance: number; endingBalance: number }> {
    const { branchId, businessDateStr, mode, confirmedAmount } = params;
    const date = this.toRecordDate(businessDateStr);
    const net = await this.sumOperationalNetCashInTx(
      client,
      branchId,
      businessDateStr,
      { forStartingPersist: mode === 'starting' },
    );
    const conf = Number(confirmedAmount.toFixed(2));

    await client.$executeRaw`
      SELECT id FROM daily_balances
      WHERE branch_id = ${branchId}::uuid AND record_date = ${date}::date
      FOR UPDATE
    `;

    const existing = await client.daily_balances.findUnique({
      where: {
        branch_id_record_date: { branch_id: branchId, record_date: date },
      },
    });

    let starting: number;
    let ending: number;

    if (mode === 'starting') {
      // Employee physical count is stored verbatim — never added to prior day balances.
      starting = conf;
      ending = Number((starting + net).toFixed(2));
    } else {
      // End-of-day: ledger ending = confirmed opening cash for this Manila date
      // + same-day operational net (Σ cash_in − Σ cash_out, excluding Start/End markers & voided).
      const daySession = await client.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: branchId,
            session_date: date,
          },
        },
        select: { starting_balance: true },
      });

      const bizSession = await client.branch_business_sessions.findUnique({
        where: {
          branch_id_business_date: {
            branch_id: branchId,
            business_date: date,
          },
        },
        select: { starting_balance: true },
      });

      const sessionConfirmedStart =
        daySession?.starting_balance != null
          ? this.dec(daySession.starting_balance)
          : bizSession?.starting_balance != null
            ? this.dec(bizSession.starting_balance)
            : null;

      if (sessionConfirmedStart != null) {
        starting = sessionConfirmedStart;
      } else if (existing) {
        starting = this.dec(existing.starting_balance);
      } else {
        const prior = await client.daily_balances.findFirst({
          where: { branch_id: branchId, record_date: { lt: date } },
          orderBy: { record_date: 'desc' },
          select: { ending_balance: true },
        });
        const branch = await client.branches.findUnique({
          where: { id: branchId },
          select: { opening_cash_balance: true },
        });
        starting = prior
          ? this.dec(prior.ending_balance)
          : this.dec(branch?.opening_cash_balance);
      }
      ending = Number((starting + net).toFixed(2));
    }

    // PostgreSQL `daily_balances_ending_balance_check` (and similar) — persisted row must not violate DB.
    if (ending < 0) {
      ending = 0;
    }
    if (ending < starting) {
      ending = starting;
    }

    this.throwIfNegativeEnding(
      ending,
      {
        branchId,
        businessDateStr,
        baselineBeforeDelta: starting,
        netChangeDecimal: Number(net.toFixed(2)),
        requiredAmountOverride: Number((-ending).toFixed(2)),
      },
      {
        // Starting/ending here are employee- or close-day-confirmed book rows, not a pawn cash-out.
        // Same-day net can make computed ending negative vs. stored start; do not block with INSUFFICIENT_FUNDS.
        skipInsufficientFundsCheck: mode === 'starting' || mode === 'ending',
      },
    );
    // Ledger persistence must not use INSUFFICIENT_FUNDS (negative book ending is allowed until corrected).

    if (existing) {
      await client.daily_balances.update({
        where: { id: existing.id },
        data: {
          starting_balance: starting,
          ending_balance: ending,
          updated_at: new Date(),
        },
      });
    } else {
      await client.daily_balances.create({
        data: {
          branch_id: branchId,
          record_date: date,
          starting_balance: starting,
          ending_balance: ending,
        },
      });
    }

    return {
      startingBalance: Number(starting.toFixed(2)),
      endingBalance: Number(ending.toFixed(2)),
    };
  }

  /**
   * Persist starting/ending after employee confirms opening or closing count.
   * Starting: stored start = confirmed physical count; end = start + same-day operational net.
   * Ending (branch close): end = confirmed session start + same-day operational net; allows negative
   * ending so the day can always close. Optional physical count is audit-only (see callers).
   */
  async persistConfirmationBalances(params: {
    branchId: string;
    businessDateStr: string;
    mode: 'starting' | 'ending';
    confirmedAmount: number;
  }): Promise<{ startingBalance: number; endingBalance: number }> {
    return this.db.$transaction(async (client) =>
      this.persistConfirmationBalancesInTx(client, params),
    );
  }
}
