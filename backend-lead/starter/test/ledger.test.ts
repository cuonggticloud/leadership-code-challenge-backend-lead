import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Wallet, WalletTx } from '../src/db/models';
import { WalletTxKind } from '../src/db/models/walletTx';
import { dec, ZERO } from '../src/lib/money';
import { createMember, createDeposit, fundWallet } from './helpers';

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

const wager = (walletId: string, amount: string) =>
  request(app).post(`/wallets/${walletId}/wagers`).send({ amount });

const withdraw = (memberId: string, amount: string) =>
  request(app).post('/withdrawals').send({ memberId, amount });

const callback = (body: Record<string, unknown>) =>
  request(app).post('/psp/callbacks').send(body);

// These assert the ledger invariants on their own terms, rather than as a side
// effect of testing an endpoint. The balance is a cache; the ledger is the
// record. If they can ever disagree, the wallet has lost money.
describe('ledger integrity', () => {
  it('reconstructs the balance from the ledger after a mixed sequence', async () => {
    const { memberId, walletId } = await createMember(app);

    await fundWallet(app, memberId, '100.00', 0);
    await fundWallet(app, memberId, '50.25', 0);
    await wager(walletId, '30.50');
    await wager(walletId, '10.75');
    await withdraw(memberId, '20.00');
    await wager(walletId, '5.00');

    // Operations that must leave no trace in the ledger at all.
    const failed = await createDeposit(app, memberId, '999.00', 0);
    await callback({ pspRef: failed.pspRef, status: 'failed', amount: '999.00' });

    const mismatched = await createDeposit(app, memberId, '500.00', 0);
    await callback({ pspRef: mismatched.pspRef, status: 'completed', amount: '499.00' });

    await wager(walletId, '99999.00'); // rejected: insufficient funds

    const entries = await WalletTx.findAll({ where: { walletId } });
    const ledgerSum = entries.reduce((sum, e) => sum.plus(dec(e.amount)), ZERO);

    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).isEqualTo(ledgerSum)).toBe(true);

    // 100 + 50.25 - 30.50 - 10.75 - 20 - 5
    expect(ledgerSum.toFixed()).toBe('84');
    // Two credits and four debits; nothing from the failed, mismatched or
    // rejected operations.
    expect(entries).toHaveLength(6);
  });

  it('records a balance_after that matches the running total at each step', async () => {
    const { memberId, walletId } = await createMember(app);

    // Each operation runs in its own transaction and is awaited in turn, so
    // created_at strictly increases and the ledger order is unambiguous. A
    // monotonic sequence column would make this robust even for entries that
    // share a transaction timestamp - see DECISIONS.md.
    await fundWallet(app, memberId, '60.00', 0);
    await wager(walletId, '15.00');
    await wager(walletId, '5.50');
    await withdraw(memberId, '10.00');

    const entries = await WalletTx.findAll({
      where: { walletId },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });

    let running = ZERO;
    for (const entry of entries) {
      running = running.plus(dec(entry.amount));
      expect(dec(entry.balanceAfter).isEqualTo(running)).toBe(true);
    }

    expect(running.toFixed()).toBe('29.5');
  });

  it('never records a negative balance_after', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '10.00', 0);

    await wager(walletId, '10.00');
    await wager(walletId, '0.01'); // rejected

    const entries = await WalletTx.findAll({ where: { walletId } });
    expect(entries.every((e) => !dec(e.balanceAfter).isNegative())).toBe(true);
  });

  it('keeps every credit positive and every debit negative', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '40.00', 0);
    await wager(walletId, '5.00');
    await withdraw(memberId, '10.00');

    const entries = await WalletTx.findAll({ where: { walletId } });
    for (const entry of entries) {
      if (entry.kind === WalletTxKind.DepositCredit) {
        expect(dec(entry.amount).isGreaterThan(ZERO)).toBe(true);
      } else {
        expect(dec(entry.amount).isLessThan(ZERO)).toBe(true);
      }
    }
  });

  // Append-only is enforced by the database rather than by convention, so even a
  // mistaken service - or someone at a psql prompt - cannot rewrite history.
  it('refuses to update a ledger entry', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '10.00', 0);

    const entry = await WalletTx.findOne();
    await expect(entry!.update({ balanceAfter: '999' })).rejects.toThrow(/append-only/);
  });

  it('refuses to delete a ledger entry', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '10.00', 0);

    const entry = await WalletTx.findOne();
    await expect(entry!.destroy()).rejects.toThrow(/append-only/);
  });

  // The hard idempotency guarantee, asserted directly: whatever the application
  // believes, the database will not apply the same money movement twice.
  it('refuses a second ledger entry with the same idempotency key', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '10.00', 0);

    const existing = await WalletTx.findOne({ where: { walletId } });

    await expect(
      WalletTx.create({
        walletId,
        kind: WalletTxKind.DepositCredit,
        amount: '10.00',
        balanceAfter: '20.00',
        idempotencyKey: existing!.idempotencyKey,
      }),
    ).rejects.toThrow();
  });

  it('refuses a ledger entry whose sign contradicts its kind', async () => {
    const { walletId } = await createMember(app);

    // A positive wager would silently credit the player.
    await expect(
      WalletTx.create({
        walletId,
        kind: WalletTxKind.Wager,
        amount: '5.00',
        balanceAfter: '5.00',
        idempotencyKey: 'wager:sign-probe',
      }),
    ).rejects.toThrow();
  });

  it('refuses a zero-amount ledger entry', async () => {
    const { walletId } = await createMember(app);

    await expect(
      WalletTx.create({
        walletId,
        kind: WalletTxKind.DepositCredit,
        amount: '0',
        balanceAfter: '0',
        idempotencyKey: 'zero-probe',
      }),
    ).rejects.toThrow();
  });
});
