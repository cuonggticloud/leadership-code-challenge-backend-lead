import { UniqueConstraintError } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { FundingTransaction, PspCallback } from '../db/models';
import { FundingKind, FundingStatus, assertTransition } from '../db/models/fundingTransaction';
import { WalletTxKind } from '../db/models/walletTx';
import { CallbackOutcome } from '../db/models/pspCallback';
import { dec } from '../lib/money';
import { NotFoundError } from '../lib/errors';
import { appendEntry, depositCreditKey, lockWalletById } from './ledgerService';

export interface PspCallbackInput {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
}

export interface CallbackResult {
  fundingTransactionId: string;
  status: FundingStatus;
  outcome: CallbackOutcome;
  detail?: string;
  balance?: string;
}

/**
 * A2. Three independent guarantees stop a deposit being credited twice:
 *
 *  1. SELECT ... FOR UPDATE on the funding transaction. Concurrent deliveries
 *     serialise there. The loser blocks, and because Postgres at READ COMMITTED
 *     re-reads a locked row at its latest committed version once the lock is
 *     released, it then sees status = Completed and no-ops. That is what makes
 *     the concurrent case work without SERIALIZABLE or a retry loop.
 *  2. The state machine: only Pending can move, so a retry arriving hours later
 *     is inert regardless of locking.
 *  3. UNIQUE(wallet_txs.idempotency_key), keyed on the funding transaction id,
 *     so the database refuses a second credit even if the logic above is wrong.
 *
 * Lock order is always funding_transactions then wallets. Nothing takes them in
 * the other order, which is what keeps this deadlock-free.
 */
export async function handleCallback(
  input: PspCallbackInput,
  rawPayload: unknown,
): Promise<CallbackResult> {
  // Audit on arrival, in its own committed transaction, BEFORE any money logic.
  // An unknown pspRef throws, and if the audit shared that transaction it would
  // roll back - losing precisely the delivery most worth recording.
  const audit = await PspCallback.create({
    pspRef: input.pspRef,
    status: input.status,
    amount: input.amount,
    payload: rawPayload,
    outcome: null,
  });

  try {
    const result = await settle(input);
    await audit.update({
      outcome: result.outcome,
      detail: result.detail ?? null,
      fundingTransactionId: result.fundingTransactionId,
    });
    return result;
  } catch (err) {
    if (err instanceof NotFoundError) {
      await audit.update({
        outcome: CallbackOutcome.UnknownRef,
        detail: 'no deposit matches this pspRef',
      });
    }
    throw err;
  }
}

async function settle(input: PspCallbackInput): Promise<CallbackResult> {
  try {
    return await sequelize.transaction(async (t) => {
      const funding = await FundingTransaction.findOne({
        where: { pspRef: input.pspRef },
        lock: true,
        transaction: t,
      });

      if (!funding || funding.kind !== FundingKind.Deposit) {
        throw new NotFoundError('no deposit found for that pspRef', { pspRef: input.pspRef });
      }

      // Already resolved.
      if (funding.status !== FundingStatus.Pending) {
        return {
          fundingTransactionId: funding.id,
          status: funding.status,
          outcome: CallbackOutcome.DuplicateIgnored,
          detail: `already ${funding.status}; callback ignored`,
        };
      }

      if (input.status === 'failed') {
        assertTransition(funding.status, FundingStatus.Failed);
        await funding.update(
          { status: FundingStatus.Failed, settledAmount: input.amount },
          { transaction: t },
        );
        return {
          fundingTransactionId: funding.id,
          status: FundingStatus.Failed,
          outcome: CallbackOutcome.MarkedFailed,
          detail: 'psp reported the payment failed',
        };
      }

      // Credit nothing if the PSP disagrees about how much arrived.
      if (!dec(input.amount).isEqualTo(dec(funding.amount))) {
        assertTransition(funding.status, FundingStatus.Failed);
        await funding.update(
          {
            status: FundingStatus.Failed,
            settledAmount: input.amount,
            mismatchReason: 'amount_mismatch',
          },
          { transaction: t },
        );
        return {
          fundingTransactionId: funding.id,
          status: FundingStatus.Failed,
          outcome: CallbackOutcome.AmountMismatch,
          detail: `expected ${funding.amount} but psp settled ${input.amount}; nothing credited`,
        };
      }

      const wallet = await lockWalletById(funding.walletId, t);
      const balance = await appendEntry({
        wallet,
        kind: WalletTxKind.DepositCredit,
        delta: dec(input.amount),
        idempotencyKey: depositCreditKey(funding.id),
        fundingTransactionId: funding.id,
        transaction: t,
      });

      assertTransition(funding.status, FundingStatus.Completed);
      await funding.update(
        { status: FundingStatus.Completed, settledAmount: input.amount },
        { transaction: t },
      );

      return {
        fundingTransactionId: funding.id,
        status: FundingStatus.Completed,
        outcome: CallbackOutcome.Credited,
        balance,
      };
    });
  } catch (err) {
    // Defence in depth. The row lock should make this unreachable, so arriving
    // here means something credited this deposit without holding the lock. The
    // constraint caught it and the transaction rolled back, so the invariant
    // that matters - exactly one credit per deposit - still holds.
    if (isDuplicateLedgerEntry(err)) {
      const funding = await FundingTransaction.findOne({ where: { pspRef: input.pspRef } });
      return {
        fundingTransactionId: funding?.id ?? '',
        status: funding?.status ?? FundingStatus.Pending,
        outcome: CallbackOutcome.DuplicateIgnored,
        detail: 'ledger entry for this deposit already exists; nothing credited',
      };
    }
    throw err;
  }
}

function isDuplicateLedgerEntry(err: unknown): boolean {
  if (!(err instanceof UniqueConstraintError)) {
    return false;
  }
  const constraint = (err.parent as { constraint?: string } | undefined)?.constraint;
  return constraint === 'wallet_txs_idempotency_key_key' || 'idempotency_key' in (err.fields ?? {});
}
