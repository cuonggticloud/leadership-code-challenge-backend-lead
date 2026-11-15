import { Router } from 'express';
import { z } from 'zod';
import { positiveMoneyString } from '../lib/moneySchema';
import * as pspCallbackService from '../services/pspCallbackService';

export const pspCallbacksRouter = Router();

const pspCallbackBody = z.object({
  pspRef: z.string().min(1).max(128),
  status: z.enum(['completed', 'failed']),
  amount: positiveMoneyString,
});

pspCallbacksRouter.post('/', async (req, res, next) => {
  try {
    const body = pspCallbackBody.parse(req.body);
    // The raw body is passed through for the audit log: what the PSP actually
    // sent, not our normalised view of it.
    const result = await pspCallbackService.handleCallback(body, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
