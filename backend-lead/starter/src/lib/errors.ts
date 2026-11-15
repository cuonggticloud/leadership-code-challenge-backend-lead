// Domain errors. Services throw these; the express error handler in app.ts is the
// single place that turns them into HTTP. Routes stay thin and never decide status
// codes, which keeps business rules out of the transport layer.
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...(this.details ?? {}) };
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(404, 'not_found', message, details);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(balance: string, requested: string) {
    super(422, 'insufficient_funds', 'wallet balance is too low for this operation', {
      balance,
      requested,
    });
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(409, 'invalid_state_transition', `cannot move a funding transaction from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

// 422 carrying how much turnover is still outstanding, so the client can tell
// the player exactly how much more they need to wager.
export class TurnoverNotMetError extends AppError {
  constructor(requiredTurnover: string, accruedTurnover: string, outstandingTurnover: string) {
    super(422, 'turnover_not_met', 'withdrawal is locked until the turnover requirement is met', {
      requiredTurnover,
      accruedTurnover,
      outstandingTurnover,
    });
  }
}
