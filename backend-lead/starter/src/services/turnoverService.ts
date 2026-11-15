import BigNumber from 'bignumber.js';
import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { FundingKind, FundingStatus } from '../db/models/fundingTransaction';
import { WalletTxKind } from '../db/models/walletTx';
import { dec, ZERO } from '../lib/money';

export interface Turnover {
  required: BigNumber;
  accrued: BigNumber;
  outstanding: BigNumber;
}

interface TurnoverRow {
  required: string;
  accrued: string;
}

/**
 * A4. Both figures are derived from the funding transactions and the ledger
 * rather than kept as counters on the wallet.
 *
 * A counter would be O(1) to read, but adds two invariants that can drift - and
 * a wrong turnover figure either traps a player's money or defeats an anti-abuse
 * control. Deriving it means one source of truth, at the cost of two indexed
 * SUMs per withdrawal.
 *
 * Both sums run on the caller's transaction, so when the caller holds the
 * wallet's row lock these figures cannot shift under a concurrent wager.
 */
export async function getTurnover(
  memberId: string,
  walletId: string,
  t: Transaction,
): Promise<Turnover> {
  const rows = await sequelize.query<TurnoverRow>(
    `SELECT
       COALESCE((SELECT SUM(amount * turnover_multiplier)
                   FROM funding_transactions
                  WHERE member_id = :memberId
                    AND kind = :depositKind
                    AND status = :completedStatus), 0)::text AS required,
       COALESCE((SELECT SUM(-amount)
                   FROM wallet_txs
                  WHERE wallet_id = :walletId
                    AND kind = :wagerKind), 0)::text AS accrued`,
    {
      replacements: {
        memberId,
        walletId,
        depositKind: FundingKind.Deposit,
        completedStatus: FundingStatus.Completed,
        wagerKind: WalletTxKind.Wager,
      },
      type: QueryTypes.SELECT,
      transaction: t,
    },
  );

  const required = dec(rows[0].required);
  const accrued = dec(rows[0].accrued);
  const difference = required.minus(accrued);

  return {
    required,
    accrued,
    outstanding: difference.isGreaterThan(ZERO) ? difference : ZERO,
  };
}
