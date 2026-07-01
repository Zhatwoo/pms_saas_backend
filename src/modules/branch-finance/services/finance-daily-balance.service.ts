import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addManilaCalendarDays } from '../../../common/utils/branch-calendar-date.util';
import { TransactionPurpose } from '../../../common/enums';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  isFundTransferBookRow,
  isInboundBranchCashFundTransferRow,
  isJournalPurposeStartEnd,
  mergeExpectedOpeningCashAmounts,
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
  private readonly fullDayNetCache = new Map<
    string,
    { at: number; value: number }
  >();
  private readonly expectedOpeningCache = new Map<
    string,
    { at: number; value: number }
  >();
  private static readonly LEDGER_READ_CACHE_MS = 8000;

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
    options?: {
      bypassOperationalSessionGate?: boolean;
      /** Use stored ending + delta (applyNetChange after a ledger row already exists). */
      useIncrementalBaseline?: boolean;
    },
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

    const { baseline, carriedForCreate } = options?.useIncrementalBaseline
      ? await this.resolveIncrementalBookBalanceInTx(
          client,
          branchId,
          businessDateStr,
        )
      : await this.resolveCurrentBookBalanceInTx(
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
    opts?: { environment?: string },
  ): Promise<T[]> {
    const branchIds = [
      ...new Set(
        rows
          .map((r) => r.branch_id)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
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
          status: {
            in: ['pending_confirmation', 'pending_source_confirmation'],
          },
          ...(opts?.environment ? { environment: opts.environment } : {}),
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
   * Incremental book balance for applyNetChange: stored daily_balances.ending_balance
   * (or confirmed session start when today's row is not written yet). Avoids double-counting
   * when the caller already persisted the transaction row before applying the delta.
   */
  private async resolveIncrementalBookBalanceInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
  ): Promise<{ baseline: number; carriedForCreate: number }> {
    const date = this.toRecordDate(businessDateStr);
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
      return { baseline: start, carriedForCreate: start };
    }

    return this.resolveCurrentBookBalanceInTx(
      client,
      branchId,
      businessDateStr,
    );
  }

  /**
   * Full book balance recompute (pre-post validation, reconciliation, live ledger display).
   * When today's branch_day_sessions row is open: confirmed session start + operational net
   * since {@link resolveOperationalCutoffMs}.
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
    opts?: { forStartingPersist?: boolean; environment?: string },
  ): Promise<T[]> {
    const out = await this.excludeInboundFundTransfersAwaitingReceiptRows(
      rows,
      undefined,
      opts,
    );
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

  private async priorBookEndingBeforeDateInTx(
    client: Tx,
    branchId: string,
    sessionDate: Date,
  ): Promise<number> {
    const prior = await client.daily_balances.findFirst({
      where: { branch_id: branchId, record_date: { lt: sessionDate } },
      orderBy: { record_date: 'desc' },
      select: { ending_balance: true },
    });
    if (prior?.ending_balance != null) {
      return Number(this.dec(prior.ending_balance).toFixed(2));
    }
    const branch = await client.branches.findUnique({
      where: { id: branchId },
      select: { opening_cash_balance: true },
    });
    return Number(this.dec(branch?.opening_cash_balance).toFixed(2));
  }

  /** Fund-transfer cash posted before the current shift cutoff (e.g. received before Start Day). */
  private async sumPreOpenFundTransferNetInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
    opts?: { environment?: string },
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const cutoffMs = await this.resolveOperationalCutoffMs(
      branchId,
      date,
      client,
    );
    if (cutoffMs <= 0) {
      return 0;
    }

    const rows = await client.transactions.findMany({
      where: {
        branch_id: branchId,
        transaction_date: date,
        voided_at: null,
        ...(opts?.environment ? { environment: opts.environment } : {}),
      },
      select: {
        id: true,
        purpose: true,
        unit: true,
        unit_code: true,
        cash_in: true,
        cash_out: true,
        created_at: true,
        branch_id: true,
      },
    });
    const preOpen = rows.filter(
      (r) =>
        isFundTransferBookRow(r) && this.txCreatedAtMs(r.created_at) < cutoffMs,
    );
    const confirmedPreOpen =
      await this.excludeInboundFundTransfersAwaitingReceiptRows(
        preOpen,
        undefined,
        opts,
      );
    return Number(operationalNetFromRows(confirmedPreOpen).toFixed(2));
  }

  /**
   * Book ending for an open branch day session. Adds pre-open fund transfers when the
   * confirmed starting balance does not already include them (e.g. starting ₱0 but fund
   * transfer received before Start Day).
   */
  async computeOpenSessionBookEnding(
    branchId: string,
    businessDateStr: string,
    existingClient?: Tx,
  ): Promise<number> {
    const run = async (client: Tx) => {
      const date = this.toRecordDate(businessDateStr);
      const daySession = await client.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: branchId,
            session_date: date,
          },
        },
        select: { starting_balance: true, is_closed: true },
      });
      if (
        !daySession ||
        daySession.is_closed ||
        daySession.starting_balance == null
      ) {
        return null;
      }

      const start = Number(this.dec(daySession.starting_balance).toFixed(2));
      const shiftNet = await this.sumOperationalNetCashInTx(
        client,
        branchId,
        businessDateStr,
      );
      const preOpenFundNet = await this.sumPreOpenFundTransferNetInTx(
        client,
        branchId,
        businessDateStr,
      );

      let ending = Number((start + shiftNet).toFixed(2));
      if (preOpenFundNet > 0) {
        const priorClose = await this.priorBookEndingBeforeDateInTx(
          client,
          branchId,
          date,
        );
        const startCoversPreOpenFund =
          start >= priorClose + preOpenFundNet - 0.01;
        if (!startCoversPreOpenFund) {
          ending = Number((ending + preOpenFundNet).toFixed(2));
        }
      }

      const row = await client.daily_balances.findUnique({
        where: {
          branch_id_record_date: { branch_id: branchId, record_date: date },
        },
        select: { ending_balance: true },
      });
      if (row?.ending_balance != null) {
        ending = Math.max(
          ending,
          Number(this.dec(row.ending_balance).toFixed(2)),
        );
      }
      return ending;
    };

    if (existingClient) {
      const result = await run(existingClient);
      return result ?? 0;
    }
    const result = await this.db.$transaction(run, {
      maxWait: 10_000,
      timeout: 30_000,
    });
    return result ?? 0;
  }

  /** Operational cash movement for a Manila business date (excludes Start/End markers and voided rows). */
  async sumOperationalNetCash(
    branchId: string,
    businessDateStr: string,
    opts?: { forStartingPersist?: boolean; environment?: string },
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const rows = await this.db.transactions.findMany({
      where: {
        branch_id: branchId,
        transaction_date: date,
        voided_at: null,
        ...(opts?.environment ? { environment: opts.environment } : {}),
      },
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
    const net = Number(operationalNetFromRows(filtered).toFixed(2));
    this.logger.warn(
      `[SumOpNet] branch=${branchId} date=${businessDateStr} allRows=${rows.length} filteredRows=${filtered.length} net=${net} filtered=${JSON.stringify(filtered.map((r) => ({ id: r.id, purpose: r.purpose, ci: r.cash_in, co: r.cash_out, created_at: r.created_at })))}`,
    );
    return net;
  }

  /**
   * Operational net for a Manila business date counting EVERY non-void operational row —
   * no session cutoff and no sealing applied (awaiting-receipt fund transfers are still
   * excluded). Used for the suggested next-session starting balance so a confirmed inbound
   * fund transfer received before the session opened is still reflected in the book; the
   * session-cutoff net would otherwise drop it and the cash would be lost.
   */
  async fullDayOperationalNetCash(
    branchId: string,
    businessDateStr: string,
    opts?: { environment?: string },
  ): Promise<number> {
    const cacheKey = `${branchId}:${businessDateStr}:${opts?.environment ?? ''}`;
    const cached = this.fullDayNetCache.get(cacheKey);
    const now = Date.now();
    if (
      cached &&
      now - cached.at < FinanceDailyBalanceService.LEDGER_READ_CACHE_MS
    ) {
      return cached.value;
    }

    const date = this.toRecordDate(businessDateStr);
    const rows = await this.db.transactions.findMany({
      where: {
        branch_id: branchId,
        transaction_date: date,
        voided_at: null,
        ...(opts?.environment ? { environment: opts.environment } : {}),
      },
      select: {
        branch_id: true,
        purpose: true,
        unit: true,
        unit_code: true,
        cash_in: true,
        cash_out: true,
      },
    });
    const filtered = await this.excludeInboundFundTransfersAwaitingReceiptRows(
      rows,
      undefined,
      opts,
    );
    const net = Number(operationalNetFromRows(filtered).toFixed(2));
    this.logger.debug(
      `[FullDayNet] branch=${branchId} date=${businessDateStr} rowCount=${rows.length} net=${net} rows=${JSON.stringify(rows)}`,
    );
    this.fullDayNetCache.set(cacheKey, { at: now, value: net });
    // No receipt-status filter here: the employee physically counts all cash on hand,
    // including fund transfers that arrived before their session opened. The suggestion
    // is informational; the employee's confirmed count is always authoritative.
    return net;
  }

  /**
   * Employee-confirmed closing balance from End Day (physical count persisted on daily_balances).
   * Used as the expected opening count for the next shift — not a recalculated ledger total.
   */
  async confirmedClosingBalanceForBusinessDate(
    branchId: string,
    businessDateStr: string,
  ): Promise<number | null> {
    const date = this.toRecordDate(businessDateStr);
    const daySession = await this.db.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: date,
        },
      },
      select: { is_closed: true },
    });
    if (!daySession?.is_closed) {
      return null;
    }

    const row = await this.db.daily_balances.findUnique({
      where: {
        branch_id_record_date: { branch_id: branchId, record_date: date },
      },
      select: { ending_balance: true },
    });
    if (row?.ending_balance == null) {
      return null;
    }
    return Number(this.dec(row.ending_balance).toFixed(2));
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
      select: { starting_balance: true, ending_balance: true },
    });

    const openSession =
      daySession &&
      !daySession.is_closed &&
      daySession.starting_balance != null;

    if (openSession) {
      return this.computeOpenSessionBookEnding(branchId, businessDateStr);
    }

    const net = await this.fullDayOperationalNetCash(branchId, businessDateStr);

    let start: number;
    if (daySession?.starting_balance != null) {
      start = Number(this.dec(daySession.starting_balance).toFixed(2));
    } else if (row) {
      start = Number(this.dec(row.starting_balance).toFixed(2));
    } else {
      start = await this.priorBookEndingBeforeDateInTx(this.db, branchId, date);
    }

    if (daySession?.is_closed && row?.ending_balance != null) {
      const stored = Number(this.dec(row.ending_balance).toFixed(2));
      const priorClose = await this.priorBookEndingBeforeDateInTx(
        this.db,
        branchId,
        date,
      );
      const bookWithTodayActivity = Number((priorClose + net).toFixed(2));
      return Math.max(stored, bookWithTodayActivity);
    }

    const computed = Number((start + net).toFixed(2));
    if (row?.ending_balance != null) {
      const stored = Number(this.dec(row.ending_balance).toFixed(2));
      return Math.max(computed, stored);
    }
    return computed;
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
      const sessionDateStr = lastClosed.session_date.toISOString().slice(0, 10);

      const confirmedClosing =
        await this.confirmedClosingBalanceForBusinessDate(
          branchId,
          sessionDateStr,
        );
      if (confirmedClosing != null) {
        let amount = confirmedClosing;
        if (sessionDateStr < businessDateStr) {
          let cursor = addManilaCalendarDays(sessionDateStr, 1);
          while (cursor <= businessDateStr) {
            amount = Number(
              (
                amount +
                (await this.fullDayOperationalNetCash(branchId, cursor))
              ).toFixed(2),
            );
            cursor = addManilaCalendarDays(cursor, 1);
          }
        } else if (sessionDateStr === businessDateStr) {
          const priorClose = await this.priorBookEndingBeforeDateInTx(
            this.db,
            branchId,
            bizDate,
          );
          const todayNet = await this.fullDayOperationalNetCash(
            branchId,
            businessDateStr,
          );
          amount = Math.max(amount, Number((priorClose + todayNet).toFixed(2)));
        }

        const todayDb = await this.db.daily_balances.findUnique({
          where: {
            branch_id_record_date: {
              branch_id: branchId,
              record_date: bizDate,
            },
          },
          select: { ending_balance: true },
        });
        if (todayDb?.ending_balance != null) {
          amount = Math.max(
            amount,
            Number(this.dec(todayDb.ending_balance).toFixed(2)),
          );
        }

        return {
          amount,
          closedSessionRecordDate: sessionDateStr,
        };
      }

      // Legacy fallback when End Day did not persist daily_balances (older DB rows).
      if (sessionDateStr === businessDateStr) {
        const priorStr = addManilaCalendarDays(businessDateStr, -1);
        const priorDayEnding = Number(
          (
            await this.ledgerBookEndingForBusinessDate(branchId, priorStr)
          ).toFixed(2),
        );
        const fullNet = await this.fullDayOperationalNetCash(
          branchId,
          businessDateStr,
        );
        return {
          amount: Math.max(0, Number((priorDayEnding + fullNet).toFixed(2))),
          closedSessionRecordDate: sessionDateStr,
        };
      }

      const ledgerOnCloseDay = Number(
        (
          await this.ledgerBookEndingForBusinessDate(branchId, sessionDateStr)
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
      (await this.ledgerBookEndingForBusinessDate(branchId, priorStr)).toFixed(
        2,
      ),
    );
    const todayNet = await this.fullDayOperationalNetCash(
      branchId,
      businessDateStr,
    );
    const todayDb = await this.db.daily_balances.findUnique({
      where: {
        branch_id_record_date: {
          branch_id: branchId,
          record_date: bizDate,
        },
      },
      select: { ending_balance: true },
    });
    const todayDbEnding =
      todayDb?.ending_balance != null
        ? Number(this.dec(todayDb.ending_balance).toFixed(2))
        : 0;
    return {
      amount: Math.max(
        openingCapital,
        ledgerPrior,
        Number((ledgerPrior + todayNet).toFixed(2)),
        todayDbEnding,
      ),
      closedSessionRecordDate: null,
    };
  }

  /**
   * Employee-confirmed End Day closing from the most recent closed session on or before
   * `businessDateStr`, plus operational net on later calendar days (e.g. pre-open fund transfer).
   */
  async lastClosedEndDayAmountForOpening(
    branchId: string,
    businessDateStr: string,
  ): Promise<{ amount: number; closedSessionDate: string | null }> {
    const bizDate = this.toRecordDate(businessDateStr);

    const lastClosed = await this.db.branch_day_sessions.findFirst({
      where: {
        branch_id: branchId,
        is_closed: true,
        session_date: { lte: bizDate },
      },
      orderBy: [{ session_date: 'desc' }, { closed_at: 'desc' }],
      select: { session_date: true },
    });

    if (!lastClosed) {
      return { amount: 0, closedSessionDate: null };
    }

    const sessionDateStr = lastClosed.session_date.toISOString().slice(0, 10);

    const balanceRow = await this.db.daily_balances.findUnique({
      where: {
        branch_id_record_date: {
          branch_id: branchId,
          record_date: lastClosed.session_date,
        },
      },
      select: { ending_balance: true },
    });

    let amount =
      balanceRow?.ending_balance != null
        ? Number(this.dec(balanceRow.ending_balance).toFixed(2))
        : Number(
            (
              await this.ledgerBookEndingForBusinessDate(
                branchId,
                sessionDateStr,
              )
            ).toFixed(2),
          );

    if (sessionDateStr < businessDateStr) {
      let cursor = addManilaCalendarDays(sessionDateStr, 1);
      while (cursor <= businessDateStr) {
        amount = Number(
          (
            amount + (await this.fullDayOperationalNetCash(branchId, cursor))
          ).toFixed(2),
        );
        cursor = addManilaCalendarDays(cursor, 1);
      }
    } else if (sessionDateStr === businessDateStr) {
      const priorClose = await this.priorBookEndingBeforeDateInTx(
        this.db,
        branchId,
        bizDate,
      );
      const todayNet = await this.fullDayOperationalNetCash(
        branchId,
        businessDateStr,
      );
      amount = Math.max(amount, Number((priorClose + todayNet).toFixed(2)));
    }

    return { amount, closedSessionDate: sessionDateStr };
  }

  /**
   * Canonical expected physical cash before Start Day is submitted — includes confirmed fund
   * transfers and same-day activity not yet reflected in the last closed session ending.
   */
  async expectedOpeningCashBeforeStartDay(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const cacheKey = `${branchId}:${businessDateStr}`;
    const cached = this.expectedOpeningCache.get(cacheKey);
    const now = Date.now();
    if (
      cached &&
      now - cached.at < FinanceDailyBalanceService.LEDGER_READ_CACHE_MS
    ) {
      return cached.value;
    }

    const bizDate = this.toRecordDate(businessDateStr);

    const fromLastEndDay = await this.lastClosedEndDayAmountForOpening(
      branchId,
      businessDateStr,
    );

    const basis = await this.suggestedStartingBasisForBusinessDate(
      branchId,
      businessDateStr,
    );

    const priorClose = await this.priorBookEndingBeforeDateInTx(
      this.db,
      branchId,
      bizDate,
    );
    const todayNet = await this.fullDayOperationalNetCash(
      branchId,
      businessDateStr,
    );

    const todayDb = await this.db.daily_balances.findUnique({
      where: {
        branch_id_record_date: {
          branch_id: branchId,
          record_date: bizDate,
        },
      },
      select: { ending_balance: true },
    });
    const todayDbEnding =
      todayDb?.ending_balance != null
        ? Number(this.dec(todayDb.ending_balance).toFixed(2))
        : 0;

    const amount = mergeExpectedOpeningCashAmounts(
      Math.max(basis.amount, fromLastEndDay.amount),
      priorClose,
      todayNet,
      todayDbEnding,
    );

    this.logger.debug(
      `[ExpectedOpeningCash] branch=${branchId} date=${businessDateStr} lastEndDay=${fromLastEndDay.amount} closedOn=${fromLastEndDay.closedSessionDate ?? 'none'} basis=${basis.amount} priorClose=${priorClose} todayNet=${todayNet} todayDb=${todayDbEnding} final=${amount}`,
    );

    const final = Number(amount.toFixed(2));
    this.expectedOpeningCache.set(cacheKey, { at: now, value: final });
    return final;
  }

  /**
   * Expected physical count when opening `businessDateStr` (Manila): the employee-confirmed End Day
   * closing balance (`daily_balances.ending_balance`) from the most recent closed session on or
   * before that date. Falls back to ledger math only when no confirmed closing row exists.
   *
   * If no closed session yet: `opening_cash_balance` vs prior-day ledger ending (first-day fallback).
   */
  async suggestedStartingCashForBusinessDate(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    return this.expectedOpeningCashBeforeStartDay(branchId, businessDateStr);
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
      const ending = await this.computeOpenSessionBookEnding(
        branchId,
        businessDateStr,
        client,
      );

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
    await this.db.$transaction(run, {
      maxWait: 10_000,
      timeout: 30_000,
    });
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
    options?: {
      bypassOperationalSessionGate?: boolean;
      environment?: string;
      createdBy?: string | null;
    },
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
          {
            bypassOperationalSessionGate: options?.bypassOperationalSessionGate,
            useIncrementalBaseline: true,
          },
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
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(options?.createdBy !== undefined
            ? { created_by: options.createdBy }
            : {}),
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

      const sessionConfirmedStart =
        daySession?.starting_balance != null
          ? this.dec(daySession.starting_balance)
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
      if (conf > 0) {
        ending = conf;
      } else {
        ending = Number((starting + net).toFixed(2));
      }
    }

    // PostgreSQL `daily_balances_ending_balance_check` (and similar) — persisted row must not violate DB.
    if (ending < 0) {
      ending = 0;
    }
    if (mode !== 'ending' && ending < starting) {
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
