import { Router } from 'express';
import { z } from 'zod';
import { positiveMoneyString } from '../lib/moneySchema';
import * as wagerService from '../services/wagerService';

export const walletsRouter = Router();

const walletIdParam = z.object({
  walletId: z.string().uuid(),
});

const createWagerBody = z.object({
  amount: positiveMoneyString,
});

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const { walletId } = walletIdParam.parse(req.params);
    const body = createWagerBody.parse(req.body);
    const result = await wagerService.recordWager(walletId, body.amount);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
