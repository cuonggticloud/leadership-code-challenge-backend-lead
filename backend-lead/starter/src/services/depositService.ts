import { randomUUID } from 'node:crypto';
import { Wallet, FundingTransaction } from '../db/models';
import { FundingKind, FundingStatus } from '../db/models/fundingTransaction';
import { NotFoundError } from '../lib/errors';

export interface CreateDepositInput {
  memberId: string;
  amount: string;
  turnoverMultiplier: number;
}

function generatePspRef(): string {
  return `psp_${randomUUID()}`;
}

export async function createDeposit(input: CreateDepositInput): Promise<FundingTransaction> {
  const wallet = await Wallet.findOne({ where: { memberId: input.memberId } });
  if (!wallet) {
    throw new NotFoundError('no wallet found for that member', { memberId: input.memberId });
  }

  return FundingTransaction.create({
    memberId: input.memberId,
    walletId: wallet.id,
    kind: FundingKind.Deposit,
    status: FundingStatus.Pending,
    amount: input.amount,
    turnoverMultiplier: input.turnoverMultiplier,
    pspRef: generatePspRef(),
  });
}
