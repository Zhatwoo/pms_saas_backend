# Branch finance audit (Phase 1)

This document records root causes of inaccurate branch balances and inventory valuation, and the remediation approach implemented in this codebase.

## Issues detected

### 1. Business date vs UTC

Some code paths wrote `transactions.transaction_date` using UTC calendar day (`toISOString().split('T')[0]`), while `daily_balances.record_date` and Prisma-created transactions used **Asia/Manila** via `getPhCalendarDateString()`. Branch summaries filter “today” using Manila; rows stored with UTC dates could fall on the wrong business day, so **cash flow totals and ledger did not match** for the same calendar day.

**Affected:** `FundRequestsService` transfer inserts, `InventoryService.markSoldAndAddToBalance` transaction inserts.

**Fix:** All inserts use Manila date strings aligned with `getPhCalendarDateString()`.

### 2. Dual balance writers and lost updates

`daily_balances.ending_balance` was updated from **Prisma** (`TransactionsService`, `PawnTicketsService`) and **Supabase** (`daily-balance.util.ts` via fund requests and inventory) using read-modify-write without row-level locking. Concurrent updates could **lose increments**.

**Fix:** Single `FinanceDailyBalanceService` using Prisma transactions and `SELECT … FOR UPDATE` on the `(branch_id, record_date)` row before updating.

### 3. Opening balance confirmation vs incremental updates

Confirming a **starting** balance set `ending_balance = declared amount` while later code **added** per-transaction deltas. If operations occurred before confirmation, totals could **understate** ending unless reconciled.

**Fix:** On starting confirmation, `ending_balance = confirmed starting + net operational cash for Manila today` (excluding Start/End markers and voided rows). Operational flow remains: opening sets baseline; further activity uses `applyNetChange`.

### 4. Ending confirmation and voided transactions

Ending reconciliation summed all non–Start/End transactions without excluding voids.

**Fix:** `voided_at` on `transactions`; net cash and reconciliation exclude rows where `voided_at` is set.

### 5. Branch summary `daily_balances` window

`getSummary` loaded the latest **4000** `daily_balances` rows globally, then derived “today” and “prior” in memory. Branches with no row in that window got **wrong carry-forward**.

**Fix:** Per-branch fetch: today’s row via `(branch_id, record_date=today)`; if missing, prior row via `(branch_id, record_date < today)` ordered desc limit 1.

### 6. Inventory valuation

Overview stats only counted `status === 'Active'` and summed **loan `amount`**, ignoring other in-stock statuses and appraisal-style value.

**Fix:** Central `inventory-valuation.util.ts` with configurable `inventory_valuation_mode` on `branches` (`LOAN_AMOUNT` vs `APPRAISED_VALUE` using `appraised_value` with fallback to `amount`), and inclusion of **Active**, **Expired** (forfeited pipeline), and **Inventory** status where present.

### 7. Duplicate aggregation risk

Any path that posts a transaction and adjusts balance twice (or not at all) drifts. All money movement must call **one** `applyNetChange` keyed by business rules.

**Fix:** Single service; `daily-balance.util.ts` delegates to Prisma service for DB consistency.

## Why balances became inaccurate (summary)

1. **Wrong calendar day** on some transaction rows → filters and sums disagreed with `daily_balances`.
2. **Race conditions** between Prisma and Supabase writers → occasional wrong `ending_balance`.
3. **Incomplete carry-forward** in summaries → wrong starting/ending for quiet branches.
4. **Opening confirmation** not adding same-day operational net when declared after activity.

## Fixed formulas (persisted)

- **Starting (day D):** prior calendar ending (Manila) or `branches.opening_cash_balance` if no prior row; manual opening confirm overwrites stored `starting_balance` for D.
- **Ending (day D):** `starting_balance(D) + Σ(cash_in − cash_out)` for operational, non-void transactions on D (excluding Start/End purposes), maintained incrementally via `applyNetChange` and reconcilable on close confirm.

## Migrations

- `branches.opening_cash_balance`, `branches.inventory_valuation_mode`
- `pawned_items.appraised_value`, `pawned_items.estimated_resale_value`
- `transactions.voided_at`, `transactions.voided_by_user_id`
- `finance_audit_events` table
- Index `transactions(branch_id, transaction_date DESC)`

## Testing

Jest unit tests cover snapshot helpers, inventory status sets, Manila date helper, and net-cash / void exclusion.

## Branch opening checklist (`daily_opening`)

Previously keyed by `(employee_id, branch_id, opening_date)`, which allowed **multiple parallel opening sessions per branch/day**.

**Now:** Unique `(branch_id, opening_date)` with optional `employee_id` and `last_updated_by_user_id` for **audit only**. All employees at the branch share one checklist state. Inventory QR scan progress in the browser uses `branch_id + Manila calendar date` so the session is branch-wide for that business day.

Migration: [`prisma/migrations/20260211140000_branch_daily_opening_session/migration.sql`](prisma/migrations/20260211140000_branch_daily_opening_session/migration.sql).

## Branch business sessions (`branch_business_sessions`)

Branch-wide Manila calendar lifecycle for finance (not per employee):

- **Statuses:** `OPEN` (operational cash allowed), `CLOSED` / `AUTO_CLOSED` (day finalized), `PENDING_START_BALANCE` (next calendar row awaiting shared starting balance).
- **Manual end day:** `POST /branch-finance/end-day` with `confirmed: true`; optional `physicalEndingAmount` for audit text. Finalizes `daily_balances` for that date, writes `END` journal marker (Prisma), stores **inventory valuation snapshot** JSON on the session row, deletes `daily_opening` for the closed date, upserts the **next** calendar session as `PENDING_START_BALANCE`.
- **Automatic midnight (Asia/Manila):** cron closes **yesterday** if still `OPEN` (idempotent if manual close already ran), logs `BRANCH_DAY_END_AUTO`, ensures today’s session row exists.
- **Starting balance:** `POST /branch-finance/daily-balance` with `type: "starting"` resolves the **earliest** `PENDING_START_BALANCE` row (often “tomorrow” while wall clock is still “today”). Opening checklist keyed by Manila **today** may briefly disagree until the calendar advances—see residual risks.

Migration: [`prisma/migrations/20260512100000_branch_business_sessions/migration.sql`](prisma/migrations/20260512100000_branch_business_sessions/migration.sql).

Operational postings call `FinanceDailyBalanceService.applyNetChange`, which requires `branch_business_sessions.status === OPEN` for that Manila date (`BranchFinanceSessionGateService`).

## Residual risks

- **Opening checklist vs pending session date:** After end-day, the next `PENDING_START_BALANCE` row may be for the **next** Manila calendar date while `getEmployeeDailyOpeningStatus` still keys `daily_opening` by **today**. Align these in a follow-up if branches often submit starting balance before midnight.
- **Historical rows** with UTC `transaction_date` may still exist; a one-time DBA backfill may be needed.
- **Distinct `pawned_items.status` values** in production may differ; the valuation helper uses a normalized allowlist—adjust if your data uses different literals.
