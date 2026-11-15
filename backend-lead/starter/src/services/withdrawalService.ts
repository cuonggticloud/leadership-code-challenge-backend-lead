import { sequelize } from '../db/sequelize';
import { FundingTransaction } from '../db/models';
import { FundingKind, FundingStatus } from '../db/models/fundingTransaction';
import { WalletTxKind } from '../db/models/walletTx';
import { dec } from '../lib/money';
import { TurnoverNotMetError } from '../lib/errors';
import { appendEntry, lockWalletByMemberId, withdrawalDebitKey } from './ledgerService';
import { getTurnover } from './turnoverService';

export interface WithdrawalResult {
  id: string;
  status: FundingStatus;
  amount: string;
  balance: string;
}

// A4. Debits the wallet immediately and leaves a Pending funding transaction for
// a human to approve later.
export async function createWithdrawal(
  memberId: string,
  amount: string,
): Promise<WithdrawalResult> {
  return sequelize.transaction(async (t) => {
    // Lock first, then read turnover. The ordering matters: reading the turnover
    // figures inside the lock is what stops a concurrent wager from changing
    // accrued turnover between the check and the debit.
    const wallet = await lockWalletByMemberId(memberId, t);

    const turnover = await getTurnover(memberId, wallet.id, t);
    if (turnover.outstanding.isGreaterThan(0)) {
      throw new TurnoverNotMetError(
        turnover.required.toFixed(),
        turnover.accrued.toFixed(),
        turnover.outstanding.toFixed(),
      );
    }

    const funding = await FundingTransaction.create(
      {
        memberId,
        walletId: wallet.id,
        kind: FundingKind.Withdrawal,
        status: FundingStatus.Pending,
        amount,
        turnoverMultiplier: 0,
        pspRef: null,
      },
      { transaction: t },
    );

    // Throws InsufficientFundsError if the balance will not cover it, rolling
    // back the funding transaction created just above.
    const balance = await appendEntry({
      wallet,
      kind: WalletTxKind.WithdrawalDebit,
      delta: dec(amount).negated(),
      idempotencyKey: withdrawalDebitKey(funding.id),
      fundingTransactionId: funding.id,
      transaction: t,
    });

    return { id: funding.id, status: funding.status, amount, balance };
  });
}
