# Part B: integrating the 50th PSP

```
POST /psp/:pspId/callbacks
  1. psp_callbacks  ← delivery + psp_id            committed first, own transaction
  2. adapter.handle(raw)  →  verify() then parse() ┐ per PSP: pure, no DB handle
                             → PspCallbackInput[]  ┘ one delivery can carry several events
  3. settle(request)  for each                       unchanged: row lock, state machine,
                                                     amount check, appendEntry
```

## The abstraction

An abstract class rather than a bare interface, because the base owns what a provider must not re-decide:

```ts
export abstract class PspAdapter {
  abstract readonly id: string;
  protected abstract readonly statusMap: Readonly<Record<string, SettleStatus>>;
  protected abstract readonly amountUnit: AmountUnit;

  protected abstract verify(raw: RawDelivery): void;
  protected abstract parse(raw: RawDelivery): PspCallbackInput[];

  handle(raw: RawDelivery): PspCallbackInput[] {   // the only public entry point
    this.verify(raw);
    return this.parse(raw);
  }

  protected mapStatus(providerStatus: string): SettleStatus { /* throws if unmapped */ }
  protected toCanonicalAmount(value: string, currency: string): string { /* ISO 4217 */ }
}
```

`verify` and `parse` are `protected`, so a subclass cannot reorder them or skip verification: nothing is
interpreted before it is authentic. `mapStatus` refuses an unmapped status rather than guessing, and
`toCanonicalAmount` is the one place minor units convert.

A provider therefore supplies five members and no money logic:

```ts
export class AcmePayAdapter extends PspAdapter {
  readonly id = 'acmepay';
  protected readonly statusMap = {
    'payment.captured': 'completed',
    'payment.declined': 'failed',
    'payment.expired': 'failed',
  };
  protected readonly amountUnit = 'minor';
  protected verify(raw) { /* HMAC, timing-safe, rotatable keys */ }
  protected parse(raw) { /* payload → mapStatus + toCanonicalAmount */ }
}
```

`src/psp/` imports no models and no services, so an adapter cannot reach the ledger. A lint fence making
that fail the build, rather than hold by convention, is the next step.

## Where verification and normalization live

**Verification is in `verify`, before anything is parsed.** Signatures cover exactly what was sent.
Secrets arrive as `() => string[]`, read at verify time rather than captured at module load, so a
rotation needs no restart and both keys work during one.

**Normalization is in `parse`, declaratively:** a `statusMap`, a declared `amountUnit`, the inherited
converter. An unmapped status throws `UnmappedPspStatusError` (422, carrying `pspId` and
`providerStatus`) and is never defaulted to `completed`. Events we do not act on return `[]`.

**Not in the adapter:** idempotency, ordering, and whether an amount is acceptable. `parse` translates
and stops; it never makes a money decision. That is what stops quirks multiplying, retries and
concurrent duplicates queue on the row lock, terminal states ignore later events, and a provider whose
`amountUnit` we misconfigured still lands as `Failed` with `mismatch_reason`, because the core compares
against what we requested. Tests cover one deposit settled by two providers concurrently, crediting once.

## How config drives it

The one-day entire junior-facing flow: one new adapter file and one line in the registry.

One line in the registry:
```
const registered: PspAdapter[] = [
  new MockPspAdapter(),
  new AcmePayAdapter(acmePaySecrets),
  new NewPspAdapter(newPspSecrets), // <- the only edit to shared code
];
```

One new adapter file:
```
export class NewPspAdapter extends PspAdapter {
  readonly id = 'newpsp';

  // implementation
}
```

`psp_callbacks.psp_id` records who delivered each callback, and an unregistered `pspId` is a 404
listing the known ids before any money logic runs.

## Testing an integration CI can't call

Adapters are pure, so most of this needs no database and no network.

Per-adapter tests cover the hostile cases offline: missing signature, wrong secret, a body tampered with
after signing, both keys mid-rotation, ignored lifecycle events.

Three additions need no reachable provider: committed sandbox fixtures under `test/psp/<id>/` for
golden-output tests, cheap to capture because `psp_callbacks` already stores every delivery; a local fake
replaying recorded `createPayment` responses, errors and timeouts included; and outside the CI gate, a
nightly sandbox run for API drift plus daily settlement reconciliation. A flaky third party must never
block a deploy.
