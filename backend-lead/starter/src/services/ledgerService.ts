import { randomUUID } from 'node:crypto';
import BigNumber from 'bignumber.js';
import { Transaction } from 'sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxKind } from '../db/models/walletTx';
import { dec } from '../lib/money';
import { InsufficientFundsError, NotFoundError } from '../lib/errors';

// Idempotency keys: one deterministic key per money movement, so "has this
// already been applied?" is answered by the UNIQUE index rather than remembered
// by the application.
export const depositCreditKey = (fundingTransactionId: string): string =>
  `deposit:${fundingTransactionId}`;

// Wagers have no external reference to key on, so this is unique but not
// deduplicating: it satisfies the constraint without providing replay
// protection. Making wagers idempotent needs a client-supplied Idempotency-Key,
// which the brief's API does not define.
export const newWagerKey = (): string => `wager:${randomUUID()}`;

// Takes the wallet's row lock.
export async function lockWalletById(walletId: string, t: Transaction): Promise<Wallet> {
  const wallet = await Wallet.findByPk(walletId, { lock: true, transaction: t });
  if (!wallet) {
    throw new NotFoundError('wallet not found', { walletId });
  }
  return wallet;
}

export interface AppendEntryInput {
  wallet: Wallet;
  kind: WalletTxKind;
  // Signed: positive credits, negative debits.
  delta: BigNumber;
  idempotencyKey: string;
  fundingTransactionId?: string | null;
  transaction: Transaction;
}

// The single chokepoint for changing a balance. The ledger entry and the cached
// balance are written together here, so no code path can move money without
// leaving an audit trail.
export async function appendEntry(input: AppendEntryInput): Promise<string> {
  const balanceAfter = dec(input.wallet.balance).plus(input.delta);

  if (balanceAfter.isNegative()) {
    throw new InsufficientFundsError(input.wallet.balance, input.delta.abs().toFixed());
  }

  await WalletTx.create(
    {
      walletId: input.wallet.id,
      kind: input.kind,
      amount: input.delta.toFixed(),
      balanceAfter: balanceAfter.toFixed(),
      fundingTransactionId: input.fundingTransactionId ?? null,
      idempotencyKey: input.idempotencyKey,
    },
    { transaction: input.transaction },
  );

  await input.wallet.update(
    { balance: balanceAfter.toFixed() },
    { transaction: input.transaction },
  );

  return balanceAfter.toFixed();
}
