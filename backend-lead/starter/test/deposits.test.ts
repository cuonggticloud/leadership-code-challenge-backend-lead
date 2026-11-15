import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { FundingTransaction } from '../src/db/models';
import { FundingKind, FundingStatus } from '../src/db/models/fundingTransaction';
import { createMember, getBalance } from './helpers';

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

describe('POST /deposits', () => {
  it('creates a Pending funding transaction and moves no money', async () => {
    const { memberId, walletId } = await createMember(app);

    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '100.50', turnoverMultiplier: 1 });

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.pspRef).toEqual(expect.stringMatching(/^psp_/));
    expect(res.body.status).toBe(FundingStatus.Pending);

    // The whole point of A1: the deposit exists, but the wallet is untouched
    // until the PSP confirms the payment actually settled.
    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');

    const stored = await FundingTransaction.findByPk(res.body.id);
    expect(stored?.kind).toBe(FundingKind.Deposit);
    expect(stored?.status).toBe(FundingStatus.Pending);
    expect(stored?.amount).toBe('100.500000000000000000');
    expect(stored?.walletId).toBe(walletId);
  });

  it('defaults turnoverMultiplier to 1 when omitted', async () => {
    const { memberId } = await createMember(app);

    const res = await request(app).post('/deposits').send({ memberId, amount: '10.00' });

    expect(res.status).toBe(201);
    expect(res.body.turnoverMultiplier).toBe(1);
  });

  it('issues a distinct pspRef per deposit', async () => {
    const { memberId } = await createMember(app);

    const first = await request(app).post('/deposits').send({ memberId, amount: '10.00' });
    const second = await request(app).post('/deposits').send({ memberId, amount: '10.00' });

    expect(first.body.pspRef).not.toBe(second.body.pspRef);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5.00'],
    ['not a number', 'abc'],
    ['exponent notation', '1e3'],
    ['leading plus', '+5.00'],
    ['surrounding whitespace', ' 5.00 '],
    ['empty', ''],
    ['more than 18 decimal places', '1.0000000000000000001'],
  ])('rejects a %s amount', async (_label, amount) => {
    const { memberId } = await createMember(app);

    const res = await request(app).post('/deposits').send({ memberId, amount });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s turnoverMultiplier', async (_label, turnoverMultiplier) => {
    const { memberId } = await createMember(app);

    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '10.00', turnoverMultiplier });

    expect(res.status).toBe(400);
  });

  it('accepts a turnoverMultiplier of 0', async () => {
    const { memberId } = await createMember(app);

    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '10.00', turnoverMultiplier: 0 });

    expect(res.status).toBe(201);
    expect(res.body.turnoverMultiplier).toBe(0);
  });

  it('returns 404 for a member that does not exist', async () => {
    const res = await request(app)
      .post('/deposits')
      .send({ memberId: randomUUID(), amount: '10.00' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('returns 400 for a malformed memberId', async () => {
    const res = await request(app).post('/deposits').send({ memberId: 'nope', amount: '10.00' });

    expect(res.status).toBe(400);
  });
});
