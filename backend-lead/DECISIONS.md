# Decisions

Part A is complete, covering deposits, PSP callbacks, wagers, and turnover-locked withdrawals. The design for Part B is in [`DESIGN-PSP.md`](DESIGN-PSP.md). I kept one commit per sub-task, and the schema was built the same way rather than designed up front.

## Locking strategy

Two concurrency problems: stopping the same deposit being credited twice, and stopping concurrent wagers spending the same balance.

For deposit callbacks I used three layers:

1. **Pessimistic row locks (`SELECT … FOR UPDATE`).** Concurrent callbacks are processed one at a time.
2. **The explicit state machine.** Only `Pending` can change state. Once a transaction is completed, later callbacks do nothing.
3. **`UNIQUE(wallet_txs.idempotency_key)`**, using the funding transaction ID as the key. The database prevents duplicate ledger entries even if the application logic has a bug.

The first two rely on application logic, which can change as new features are added. The unique constraint is a final safeguard at the database level. For example, if someone adds another service that credits deposits without acquiring the lock, the database rejects the duplicate instead of silently crediting the wallet twice.

For wagers and withdrawals the mechanism is simpler: a row lock on the wallet, taken before the balance is read. Without it, two requests both read the old balance, both decide there are enough funds, and both write.

## Schema choices

**The ledger is append-only, and the balance is always `SUM(amount)`.** Amounts are signed — credits positive, debits negative — rather than positive with the direction implied by `kind`, so reconstruction is a plain `SUM` and a class of "forgot to negate" bugs disappears.

**One place where money moves.** `ledgerService.appendEntry` is the only function that can change a balance, and it writes the ledger row and updates `wallets.balance` together. No code path can move money without leaving an audit trail.

**A callback whose amount disagrees credits nothing.** `settled_amount` and `mismatch_reason` are recorded, the transaction moves to `Failed`, and we return `200` so the PSP stops retrying. In a regulated system, moving an amount nobody asked for is worse than making a human look at it, and keeping both figures leaves the discrepancy reconstructible.

## What I'd do next with more time

In priority order, with the reason rather than just the task:

1. **Client-supplied `Idempotency-Key` on wagers and withdrawals.** The deposit path is protected three ways; the debit paths have no replay protection at all, so a retried wager debits twice. The largest remaining correctness hole.
2. **A reconciliation job** to recompute every balance from the ledger, compare against `wallets.balance`, alert on drift. The data supports it today and nothing runs it, so the cached balance is currently trusted rather than verified.
3. **Improve `getTurnover`.** It always recomputes both figures from scratch, two `SUM` aggregates over the member's entire history on every withdrawal, and it runs *inside* the wallet row lock, so that scan time is held while anything else touching that wallet queues behind it. The indexes keep it cheap now, but the cost grows with every wager a member ever places, and the heaviest wagerers are exactly the ones who withdraw. The fix is an `accrued_turnover` and `required_turnover` counter on `wallets`.

## AI disclosure

I've worked on money movement systems before, so the design decisions here are my own. I worked through the implementation one sub-task at a time, using Claude Code to help draft the code, then reviewing and committing each step before moving on to the next.

AI mainly helped me save implementation time by writing migrations, services, routes, and tests based on the approach I'd already decided on. I also used it to run mutation tests to make sure the concurrency tests actually fail when the protections they're testing are removed.
