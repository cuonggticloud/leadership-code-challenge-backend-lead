import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { WalletTx } from '../src/db/models';
import { WalletTxKind } from '../src/db/models/walletTx';
import { dec, ZERO } from '../src/lib/money';
import { createMember, fundWallet, getBalance } from './helpers';

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

describe('POST /wallets/:walletId/wagers', () => {
  it('debits the wallet and writes a ledger entry', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00');

    const res = await wager(walletId, '10.00');

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('90');
    expect(await getBalance(app, memberId)).toBe('90.000000000000000000');

    const entries = await WalletTx.findAll({ where: { kind: WalletTxKind.Wager } });
    expect(entries).toHaveLength(1);
    // Debits are stored negative, so a balance is always SUM(amount).
    expect(entries[0].amount).toBe('-10.000000000000000000');
    expect(entries[0].balanceAfter).toBe('90.000000000000000000');
    // A wager is not tied to a funding transaction.
    expect(entries[0].fundingTransactionId).toBeNull();
  });

  it('rejects a wager larger than the balance', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '10.00');

    const res = await wager(walletId, '10.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(res.body.balance).toBe('10.000000000000000000');
    expect(res.body.requested).toBe('10.01');
    expect(await getBalance(app, memberId)).toBe('10.000000000000000000');
    expect(await WalletTx.count({ where: { kind: WalletTxKind.Wager } })).toBe(0);
  });

  it('allows a wager for the exact balance', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '10.00');

    const res = await wager(walletId, '10.00');

    expect(res.status).toBe(201);
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
  });

  it('rejects any wager on an empty wallet', async () => {
    const { walletId } = await createMember(app);

    const res = await wager(walletId, '0.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
  });

  // A3: two concurrent wagers must not overdraw the wallet. This is the case a
  // naive read-check-write gets wrong.
  it('cannot be overdrawn by concurrent wagers', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00');

    // Four at 30.00 against a balance of 100.00: three fit, the fourth must not.
    const results = await Promise.all([
      wager(walletId, '30.00'),
      wager(walletId, '30.00'),
      wager(walletId, '30.00'),
      wager(walletId, '30.00'),
    ]);

    const accepted = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 422);

    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.error).toBe('insufficient_funds');

    expect(await getBalance(app, memberId)).toBe('10.000000000000000000');
    expect(await WalletTx.count({ where: { kind: WalletTxKind.Wager } })).toBe(3);
  });

  // The mirror image: the lock must serialise without spuriously rejecting
  // wagers that genuinely fit.
  it('accepts concurrent wagers that exactly exhaust the balance', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00');

    const results = await Promise.all([
      wager(walletId, '25.00'),
      wager(walletId, '25.00'),
      wager(walletId, '25.00'),
      wager(walletId, '25.00'),
    ]);

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
  });

  it('keeps the ledger consistent with the balance under concurrency', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100.00');

    await Promise.all([
      wager(walletId, '30.00'),
      wager(walletId, '30.00'),
      wager(walletId, '30.00'),
      wager(walletId, '30.00'),
    ]);

    const entries = await WalletTx.findAll({ where: { walletId } });
    const ledgerSum = entries.reduce((sum, e) => sum.plus(dec(e.amount)), ZERO);
    expect(ledgerSum.toFixed()).toBe('10');

    // Every balance_after must be distinct: had two wagers interleaved they
    // would have computed the same running balance.
    const balancesAfter = entries
      .filter((e) => e.kind === WalletTxKind.Wager)
      .map((e) => e.balanceAfter);
    expect(new Set(balancesAfter).size).toBe(balancesAfter.length);
  });

  it('returns 404 for a wallet that does not exist', async () => {
    const res = await wager(randomUUID(), '10.00');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5.00'],
    ['not a number', 'abc'],
    ['more than 18 decimal places', '1.0000000000000000001'],
  ])('returns 400 for a %s amount', async (_label, amount) => {
    const { walletId } = await createMember(app);

    const res = await wager(walletId, amount);

    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed walletId', async () => {
    const res = await wager('not-a-uuid', '10.00');

    expect(res.status).toBe(400);
  });
});
