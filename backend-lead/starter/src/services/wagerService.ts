import { sequelize } from '../db/sequelize';
import { WalletTxKind } from '../db/models/walletTx';
import { dec } from '../lib/money';
import { appendEntry, lockWalletById, newWagerKey } from './ledgerService';

export interface WagerResult {
  walletId: string;
  amount: string;
  balance: string;
}

// A3. Debits the wallet and, by virtue of the ledger entry, accrues turnover.
export async function recordWager(walletId: string, amount: string): Promise<WagerResult> {
  return sequelize.transaction(async (t) => {
    const wallet = await lockWalletById(walletId, t);

    const balance = await appendEntry({
      wallet,
      kind: WalletTxKind.Wager,
      delta: dec(amount).negated(),
      idempotencyKey: newWagerKey(),
      transaction: t,
    });

    return { walletId: wallet.id, amount, balance };
  });
}
