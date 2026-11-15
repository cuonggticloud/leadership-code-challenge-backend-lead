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
