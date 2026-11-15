import { z } from 'zod';
import { dec } from './money';

// Money is DECIMAL(36,18) in Postgres: at most 18 fractional digits and, with 36
// total, at most 18 integer digits.
export const MAX_DECIMAL_PLACES = 18;
export const MAX_INTEGER_DIGITS = 18;

// Anchored, no sign, no exponent, no whitespace. Deliberately stricter than
// BigNumber's own parser: "1e3", "+5.00" and " 5.00 " are all things a sloppy
// client might send, and none of them should reach the money math.
const DECIMAL_STRING = /^\d+(\.\d+)?$/;

// One superRefine rather than a chain of .refine() calls, and the ordering is
// load-bearing. A failing zod string check marks the result "dirty", not
// "aborted", and zod still runs subsequent refinements on a dirty value - so a
// chained .refine() calling dec() would be handed "abc", and dec() throws on a
// non-finite value. That surfaces as a 500 for what is plainly a 400. Here the
// regex gate returns early, so dec() below is only ever reached with a value it
// can parse.
export const positiveMoneyString = z.string().superRefine((value, ctx) => {
  if (!DECIMAL_STRING.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be a decimal string with no sign or exponent, e.g. "100.50"',
    });
    return;
  }

  const amount = dec(value);

  if (!amount.isGreaterThan(0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be greater than zero' });
    return;
  }

  // Excess precision is refused rather than accepted and quietly altered:
  // money.ts configures BigNumber with ROUND_DOWN, and Postgres rounds to scale
  // on insert, so a 19-decimal amount would silently become a different number.
  if ((amount.decimalPlaces() ?? 0) > MAX_DECIMAL_PLACES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must have at most ${MAX_DECIMAL_PLACES} decimal places`,
    });
  }

  if (amount.integerValue().toFixed().length > MAX_INTEGER_DIGITS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must have at most ${MAX_INTEGER_DIGITS} digits before the decimal point`,
    });
  }
});
