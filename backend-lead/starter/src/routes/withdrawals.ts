import { Router } from 'express';
import { z } from 'zod';
import { positiveMoneyString } from '../lib/moneySchema';
import * as withdrawalService from '../services/withdrawalService';

export const withdrawalsRouter = Router();

const createWithdrawalBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoneyString,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = createWithdrawalBody.parse(req.body);
    const result = await withdrawalService.createWithdrawal(body.memberId, body.amount);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
