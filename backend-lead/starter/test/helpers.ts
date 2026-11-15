import request from 'supertest';
import type { Express } from 'express';

// Shared fixtures. Not a test file: jest's default testMatch only picks up
// *.test.ts, so this is never run as a suite.

export interface TestMember {
  memberId: string;
  walletId: string;
}

let counter = 0;

export async function createMember(app: Express): Promise<TestMember> {
  counter += 1;
  const res = await request(app)
    .post('/members')
    .send({ username: `player${counter}x${Date.now() % 1000000}` });

  if (res.status !== 201) {
    throw new Error(`fixture: could not create member (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { memberId: res.body.member.id, walletId: res.body.wallet.id };
}

export async function getBalance(app: Express, memberId: string): Promise<string> {
  const res = await request(app).get(`/members/${memberId}/wallet`);
  return res.body.balance;
}

export async function createDeposit(
  app: Express,
  memberId: string,
  amount: string,
  turnoverMultiplier = 0,
): Promise<{ id: string; pspRef: string }> {
  const res = await request(app).post('/deposits').send({ memberId, amount, turnoverMultiplier });
  if (res.status !== 201) {
    throw new Error(`fixture: could not create deposit (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id, pspRef: res.body.pspRef };
}

// Deposit + settle, for tests that just need a funded wallet. Defaults to a
// turnover multiplier of 0 so the funds carry no turnover requirement unless a
// test is specifically exercising it.
export async function fundWallet(
  app: Express,
  memberId: string,
  amount: string,
  turnoverMultiplier = 0,
): Promise<void> {
  const deposit = await createDeposit(app, memberId, amount, turnoverMultiplier);
  const res = await request(app)
    .post('/psp/callbacks')
    .send({ pspRef: deposit.pspRef, status: 'completed', amount });
  if (res.status !== 200) {
    throw new Error(`fixture: could not settle deposit (${res.status}): ${JSON.stringify(res.body)}`);
  }
}
