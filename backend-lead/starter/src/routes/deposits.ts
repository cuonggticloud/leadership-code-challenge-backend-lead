import { Router } from 'express';
import { z } from 'zod';
import { positiveMoneyString } from '../lib/moneySchema';
import * as depositService from '../services/depositService';

export const depositsRouter = Router();

const createDepositBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoneyString,
  turnoverMultiplier: z.number().int().min(0).default(1),
});

depositsRouter.post('/', async (req, res, next) => {
  try {
    const body = createDepositBody.parse(req.body);
    const deposit = await depositService.createDeposit(body);
    res.status(201).json({
      id: deposit.id,
      pspRef: deposit.pspRef,
      status: deposit.status,
      amount: deposit.amount,
      turnoverMultiplier: deposit.turnoverMultiplier,
    });
  } catch (err) {
    next(err);
  }
});
