import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { FundingTransaction, WalletTx, PspCallback } from '../src/db/models';
import { FundingStatus } from '../src/db/models/fundingTransaction';
import { WalletTxKind } from '../src/db/models/walletTx';
import { CallbackOutcome } from '../src/db/models/pspCallback';
import { dec, ZERO } from '../src/lib/money';
import { createMember, createDeposit, getBalance } from './helpers';

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

const callback = (body: Record<string, unknown>) =>
  request(app).post('/psp/callbacks').send(body);

describe('POST /psp/callbacks', () => {
  it('credits the wallet exactly once and completes the deposit', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '100.50');

    const res = await callback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.50' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe(CallbackOutcome.Credited);
    expect(res.body.status).toBe(FundingStatus.Completed);
    expect(await getBalance(app, memberId)).toBe('100.500000000000000000');

    const entries = await WalletTx.findAll({ where: { fundingTransactionId: deposit.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe(WalletTxKind.DepositCredit);
    expect(entries[0].amount).toBe('100.500000000000000000');
    expect(entries[0].balanceAfter).toBe('100.500000000000000000');

    const stored = await FundingTransaction.findByPk(deposit.id);
    expect(stored?.settledAmount).toBe('100.500000000000000000');
  });

  // A2: retries, sometimes minutes or hours late.
  it('does not double-credit a duplicate callback delivered sequentially', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '100.50');
    const body = { pspRef: deposit.pspRef, status: 'completed', amount: '100.50' };

    const first = await callback(body);
    const second = await callback(body);
    const third = await callback(body);

    expect(first.body.outcome).toBe(CallbackOutcome.Credited);
    expect(second.body.outcome).toBe(CallbackOutcome.DuplicateIgnored);
    expect(third.body.outcome).toBe(CallbackOutcome.DuplicateIgnored);
    expect(second.status).toBe(200);

    expect(await getBalance(app, memberId)).toBe('100.500000000000000000');
    expect(await WalletTx.count({ where: { fundingTransactionId: deposit.id } })).toBe(1);
  });

  // A2: two deliveries arriving concurrently. This is the case a naive
  // check-then-credit implementation gets wrong.
  it('does not double-credit two concurrent duplicate callbacks', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '100.50');
    const body = { pspRef: deposit.pspRef, status: 'completed', amount: '100.50' };

    const [a, b] = await Promise.all([callback(body), callback(body)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.outcome, b.body.outcome].sort()).toEqual(
      [CallbackOutcome.Credited, CallbackOutcome.DuplicateIgnored].sort(),
    );

    expect(await getBalance(app, memberId)).toBe('100.500000000000000000');
    expect(await WalletTx.count({ where: { fundingTransactionId: deposit.id } })).toBe(1);
  });

  it('does not double-credit four concurrent duplicate callbacks', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '25.00');
    const body = { pspRef: deposit.pspRef, status: 'completed', amount: '25.00' };

    const results = await Promise.all([
      callback(body),
      callback(body),
      callback(body),
      callback(body),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === CallbackOutcome.Credited)).toHaveLength(1);

    expect(await getBalance(app, memberId)).toBe('25.000000000000000000');
    expect(await WalletTx.count({ where: { fundingTransactionId: deposit.id } })).toBe(1);
  });

  it('marks the deposit Failed and credits nothing when the psp reports failure', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '40.00');

    const res = await callback({ pspRef: deposit.pspRef, status: 'failed', amount: '40.00' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe(CallbackOutcome.MarkedFailed);
    expect(res.body.status).toBe(FundingStatus.Failed);
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
    expect(await WalletTx.count()).toBe(0);
  });

  // Documented decision: a disagreement about the amount credits nothing and
  // parks the deposit as Failed with both figures retained.
  it('rejects a callback whose amount differs from the deposit', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '100.50');

    const res = await callback({ pspRef: deposit.pspRef, status: 'completed', amount: '99.00' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe(CallbackOutcome.AmountMismatch);
    expect(res.body.status).toBe(FundingStatus.Failed);
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
    expect(await WalletTx.count()).toBe(0);

    const stored = await FundingTransaction.findByPk(deposit.id);
    expect(stored?.amount).toBe('100.500000000000000000');
    expect(stored?.settledAmount).toBe('99.000000000000000000');
    expect(stored?.mismatchReason).toBe('amount_mismatch');
  });

  it('treats a trailing-zero amount as equal, not as a mismatch', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '100.50');

    const res = await callback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.5000' });

    expect(res.body.outcome).toBe(CallbackOutcome.Credited);
    expect(await getBalance(app, memberId)).toBe('100.500000000000000000');
  });

  it('returns 404 for an unknown pspRef and still audits the delivery', async () => {
    const res = await callback({ pspRef: 'psp_does-not-exist', status: 'completed', amount: '10.00' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');

    const audited = await PspCallback.findOne({ where: { pspRef: 'psp_does-not-exist' } });
    expect(audited).not.toBeNull();
    expect(audited?.outcome).toBe(CallbackOutcome.UnknownRef);
  });

  it('will not re-settle a deposit that already failed', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '40.00');

    await callback({ pspRef: deposit.pspRef, status: 'failed', amount: '40.00' });
    const res = await callback({ pspRef: deposit.pspRef, status: 'completed', amount: '40.00' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe(CallbackOutcome.DuplicateIgnored);
    expect(res.body.status).toBe(FundingStatus.Failed);
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
  });

  it('audits every delivery, including ignored duplicates', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '10.00');
    const body = { pspRef: deposit.pspRef, status: 'completed', amount: '10.00' };

    await callback(body);
    await callback(body);

    const audited = await PspCallback.findAll({
      where: { pspRef: deposit.pspRef },
      order: [['createdAt', 'ASC']],
    });
    expect(audited).toHaveLength(2);
    expect(audited.map((a) => a.outcome)).toContain(CallbackOutcome.Credited);
    expect(audited.map((a) => a.outcome)).toContain(CallbackOutcome.DuplicateIgnored);
    // The raw payload is retained verbatim for reconciliation.
    expect(audited[0].payload).toEqual(body);
  });

  it('keeps the balance reconstructible from the ledger', async () => {
    const { memberId, walletId } = await createMember(app);
    const first = await createDeposit(app, memberId, '60.00');
    const second = await createDeposit(app, memberId, '15.25');

    await callback({ pspRef: first.pspRef, status: 'completed', amount: '60.00' });
    await callback({ pspRef: second.pspRef, status: 'completed', amount: '15.25' });

    const entries = await WalletTx.findAll({ where: { walletId } });
    // Money never touches JS number, in tests either: a float sum could agree
    // with a balance that is actually wrong in the 18th decimal place.
    const sum = entries.reduce((acc, e) => acc.plus(dec(e.amount)), ZERO);
    expect(sum.toFixed()).toBe('75.25');
    expect(await getBalance(app, memberId)).toBe('75.250000000000000000');
  });

  it('refuses to mutate a ledger entry', async () => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '10.00');
    await callback({ pspRef: deposit.pspRef, status: 'completed', amount: '10.00' });

    const entry = await WalletTx.findOne();
    await expect(entry!.update({ balanceAfter: '999' })).rejects.toThrow(/append-only/);
    await expect(entry!.destroy()).rejects.toThrow(/append-only/);
  });

  it.each([
    ['an unknown status', { status: 'pending' }],
    ['a missing pspRef', { pspRef: undefined }],
    ['a negative amount', { amount: '-10.00' }],
  ])('returns 400 for %s', async (_label, override) => {
    const { memberId } = await createMember(app);
    const deposit = await createDeposit(app, memberId, '10.00');

    const res = await callback({
      pspRef: deposit.pspRef,
      status: 'completed',
      amount: '10.00',
      ...override,
    });

    expect(res.status).toBe(400);
  });
});
