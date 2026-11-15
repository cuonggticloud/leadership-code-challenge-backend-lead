import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { FundingTransaction, WalletTx } from '../src/db/models';
import { FundingKind, FundingStatus } from '../src/db/models/fundingTransaction';
import { WalletTxKind } from '../src/db/models/walletTx';
import { createMember, createDeposit, fundWallet, getBalance } from './helpers';

const app = createApp();

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await sequelize.close();
});

const withdraw = (memberId: string, amount: string) =>
  request(app).post('/withdrawals').send({ memberId, amount });

const wager = (walletId: string, amount: string) =>
  request(app).post(`/wallets/${walletId}/wagers`).send({ amount });

describe('POST /withdrawals', () => {
  it('allows withdrawal immediately when the deposit carried no turnover requirement', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 0);

    const res = await withdraw(memberId, '50.00');

    expect(res.status).toBe(201);
    expect(res.body.status).toBe(FundingStatus.Pending);
    expect(await getBalance(app, memberId)).toBe('50.000000000000000000');
  });

  it('debits immediately and leaves a Pending funding transaction for approval', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 0);

    const res = await withdraw(memberId, '30.00');

    const stored = await FundingTransaction.findByPk(res.body.id);
    expect(stored?.kind).toBe(FundingKind.Withdrawal);
    expect(stored?.status).toBe(FundingStatus.Pending);
    expect(stored?.amount).toBe('30.000000000000000000');
    expect(stored?.pspRef).toBeNull();

    // Money has already left the wallet; approval is a separate, later step.
    expect(await getBalance(app, memberId)).toBe('70.000000000000000000');
    const debit = await WalletTx.findOne({ where: { kind: WalletTxKind.WithdrawalDebit } });
    expect(debit?.amount).toBe('-30.000000000000000000');
    expect(debit?.fundingTransactionId).toBe(res.body.id);
  });

  // A4: the anti-abuse control. 100.00 deposited at a multiplier of 1 requires
  // 100.00 of turnover before anything can leave.
  it('blocks withdrawal while turnover is outstanding and reports how much', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 1);
    await wager(walletId, '40.00');

    const res = await withdraw(memberId, '10.00');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('turnover_not_met');
    expect(res.body.requiredTurnover).toBe('100');
    expect(res.body.accruedTurnover).toBe('40');
    expect(res.body.outstandingTurnover).toBe('60');

    // Nothing moved.
    expect(await getBalance(app, memberId)).toBe('60.000000000000000000');
    expect(await FundingTransaction.count({ where: { kind: FundingKind.Withdrawal } })).toBe(0);
  });

  it('blocks withdrawal entirely when no turnover has been accrued', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 1);

    const res = await withdraw(memberId, '10.00');

    expect(res.status).toBe(422);
    expect(res.body.outstandingTurnover).toBe('100');
  });

  it('unblocks withdrawal once the turnover requirement is met', async () => {
    const { memberId, walletId } = await createMember(app);
    // 100.00 locked behind a 1x requirement, plus 50.00 carrying no requirement.
    // The player must wager through the locked portion to free the rest - there
    // are no winnings in this system, so a 1x multiplier consumes the deposit.
    await fundWallet(app, memberId, '100.00', 1);
    await fundWallet(app, memberId, '50.00', 0);

    const blocked = await withdraw(memberId, '20.00');
    expect(blocked.status).toBe(422);

    await wager(walletId, '100.00');

    const res = await withdraw(memberId, '20.00');
    expect(res.status).toBe(201);
    // 150 deposited - 100 wagered - 20 withdrawn.
    expect(await getBalance(app, memberId)).toBe('30.000000000000000000');
  });

  it('accumulates the requirement across several deposits', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '10.00', 2); // requires 20
    await fundWallet(app, memberId, '30.00', 1); // requires 30

    await wager(walletId, '10.00');

    const res = await withdraw(memberId, '5.00');
    expect(res.status).toBe(422);
    expect(res.body.requiredTurnover).toBe('50');
    expect(res.body.accruedTurnover).toBe('10');
    expect(res.body.outstandingTurnover).toBe('40');
  });

  it('does not count a failed deposit toward the requirement', async () => {
    const { memberId } = await createMember(app);
    // Settled with the wrong amount, so it is Failed and credited nothing.
    const rejected = await createDeposit(app, memberId, '100.00', 5);
    await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: rejected.pspRef, status: 'completed', amount: '99.00' });

    await fundWallet(app, memberId, '40.00', 0);

    // The failed deposit's 500.00 requirement must not apply - it never credited.
    const res = await withdraw(memberId, '40.00');
    expect(res.status).toBe(201);
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
  });

  it('does not count a pending deposit toward the requirement', async () => {
    const { memberId } = await createMember(app);
    await createDeposit(app, memberId, '100.00', 3); // never settled
    await fundWallet(app, memberId, '25.00', 0);

    const res = await withdraw(memberId, '25.00');
    expect(res.status).toBe(201);
  });

  it('does not bank surplus turnover beyond the requirement', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 1);
    await wager(walletId, '100.00'); // accrued 100 against a requirement of 100

    // A later deposit brings its own requirement; the clamp at zero means the
    // earlier surplus cannot offset it.
    await fundWallet(app, memberId, '20.00', 1);

    const res = await withdraw(memberId, '10.00');
    expect(res.status).toBe(422);
    expect(res.body.requiredTurnover).toBe('120');
    expect(res.body.accruedTurnover).toBe('100');
    expect(res.body.outstandingTurnover).toBe('20');
  });

  it('rejects a withdrawal larger than the balance', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '10.00', 0);

    const res = await withdraw(memberId, '10.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(await getBalance(app, memberId)).toBe('10.000000000000000000');
    // The funding transaction created before the debit must have rolled back.
    expect(await FundingTransaction.count({ where: { kind: FundingKind.Withdrawal } })).toBe(0);
  });

  it('cannot be overdrawn by concurrent withdrawals', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 0);

    const results = await Promise.all([
      withdraw(memberId, '60.00'),
      withdraw(memberId, '60.00'),
    ]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(1);
    expect(await getBalance(app, memberId)).toBe('40.000000000000000000');
  });

  // A concurrent wager must not let a withdrawal through on a turnover figure
  // that was true a moment earlier.
  it('does not let a concurrent wager race the turnover check', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00', 1);

    const [withdrawal] = await Promise.all([
      withdraw(memberId, '10.00'),
      wager(walletId, '100.00'),
    ]);

    // Whichever order they serialise in, the withdrawal is only allowed if the
    // requirement was already met when it held the lock.
    if (withdrawal.status === 201) {
      expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
    } else {
      expect(withdrawal.status).toBe(422);
    }
  });

  it('returns 404 for a member that does not exist', async () => {
    const res = await withdraw(randomUUID(), '10.00');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it.each([
    ['negative', '-10.00'],
    ['zero', '0'],
    ['not a number', 'abc'],
  ])('returns 400 for a %s amount', async (_label, amount) => {
    const { memberId } = await createMember(app);

    const res = await withdraw(memberId, amount);

    expect(res.status).toBe(400);
  });
});
