import { describe, expect, it } from 'vitest';
import {
  actingClients,
  addStep,
  asDefinition,
  checkExpiry,
  dateIn,
  defaultEffectiveFrom,
  durationMs,
  effectiveFromOk,
  expiryOf,
  groupAttempts,
  isBelowCost,
  issuerBlocked,
  issuesOf,
  layoutDefinition,
  m11Error,
  marginPreview,
  maskSecrets,
  moneyText,
  percentToBps,
  previousPeriod,
  problemOf,
  removeStep,
  replaceStep,
  retailPreview,
  starterDefinition,
  toMinor,
  validPeriod,
  validateDefinition,
  type GrantDto,
  type LinkDto,
  type WorkflowDefinition,
} from './m11';

const def = (
  steps: WorkflowDefinition['steps'],
  start = steps[0]?.id ?? '',
): WorkflowDefinition => ({ schemaVersion: 1, start, steps });

describe('workflow definition hints', () => {
  it('accepts the starter definition', () => {
    expect(validateDefinition(starterDefinition()).errors).toEqual([]);
  });
  it('finds an unknown successor, a cycle and an unreachable step', () => {
    const a = validateDefinition(
      def([{ id: 'a', type: 'delay', params: { seconds: 1 }, next: 'zzz' }]),
    );
    expect(a.errors.map((e) => e.code)).toContain('invalid_graph');
    const c = validateDefinition(
      def([
        { id: 'a', type: 'delay', params: { seconds: 1 }, next: 'b' },
        { id: 'b', type: 'delay', params: { seconds: 1 }, next: 'a' },
      ]),
    );
    expect(c.errors.map((e) => e.code)).toContain('cycle');
    const u = validateDefinition(
      def(
        [
          { id: 'a', type: 'delay', params: { seconds: 1 } },
          { id: 'b', type: 'delay', params: { seconds: 1 } },
        ],
        'a',
      ),
    );
    expect(u.errors.map((e) => e.code)).toContain('unreachable_step');
  });
  it('checks step parameters', () => {
    const r = validateDefinition(def([{ id: 'a', type: 'delay', params: { seconds: 0 } }]));
    expect(r.errors[0]?.path).toBe('$.steps[0].params.seconds');
    const h = validateDefinition(
      def([
        {
          id: 'a',
          type: 'http_request',
          params: { method: 'GET', url: 'http://insecure.example' },
        },
      ]),
    );
    expect(h.errors.map((e) => e.message).join()).toContain('https');
    const d = validateDefinition(def([{ id: 'A!', type: 'delay', params: { seconds: 1 } }]));
    expect(d.errors[0]?.path).toBe('$.steps[0].id');
  });
  it('refuses credential-looking values and warns about a non-idempotent POST', () => {
    const s = validateDefinition(
      def([
        {
          id: 'a',
          type: 'http_request',
          params: {
            method: 'POST',
            url: 'https://x.example',
            headers: { authorization: 'Bearer abcdefghijkl' },
          },
        },
      ]),
    );
    expect(s.errors.map((e) => e.code)).toContain('secret_in_definition');
    expect(s.warnings.map((e) => e.code)).toContain('non_idempotent');
    const ok = validateDefinition(
      def([
        {
          id: 'a',
          type: 'http_request',
          idempotencyKey: '{{ execution.id }}',
          params: { method: 'POST', url: 'https://x.example' },
        },
      ]),
    );
    expect(ok.warnings).toEqual([]);
  });
  it('requires both branches to name real steps for a condition and rejects next on it', () => {
    const r = validateDefinition(
      def([
        { id: 'c', type: 'condition', params: { expr: 'input.x > 1' }, next: 'd' },
        { id: 'd', type: 'delay', params: { seconds: 1 } },
      ]),
    );
    expect(r.errors.map((e) => e.path)).toContain('$.steps.c');
  });
  it('rejects things that are not a definition', () => {
    expect(validateDefinition(null).errors[0]?.code).toBe('invalid_definition');
    expect(
      validateDefinition({ schemaVersion: 2, start: 'a', steps: [] }).errors.length,
    ).toBeGreaterThan(0);
    expect(asDefinition({ steps: 'x' })).toBeNull();
  });
});

describe('canvas layout and editing', () => {
  const branching = def([
    { id: 'a', type: 'delay', params: { seconds: 1 }, next: 'c' },
    { id: 'c', type: 'condition', params: { expr: 'input.x' }, onTrue: 't', onFalse: 'f' },
    { id: 't', type: 'delay', params: { seconds: 1 }, next: 'end' },
    { id: 'f', type: 'delay', params: { seconds: 1 }, next: 'end' },
    { id: 'end', type: 'delay', params: { seconds: 1 } },
    { id: 'lost', type: 'delay', params: { seconds: 1 } },
  ]);
  it('gives each depth a row and the false branch its own lane; a rejoin keeps its lane', () => {
    const l = layoutDefinition(branching);
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    expect([at('a').row, at('c').row, at('t').row, at('end').row]).toEqual([0, 1, 2, 3]);
    expect(at('t').lane).toBe(0);
    expect(at('f').lane).toBe(1);
    expect(at('end').lane).toBe(0);
    expect(l.lanes).toBe(2);
    expect(at('lost').orphan).toBe(true);
    expect(l.edges.filter((e) => e.kind === 'false')).toHaveLength(1);
  });
  it('lists the cards in reading order (row, then lane)', () => {
    const ids = layoutDefinition(branching).nodes.map((n) => n.id);
    expect(ids.slice(0, 4)).toEqual(['a', 'c', 't', 'f']);
  });
  it('survives a cycle (it only draws what it can)', () => {
    const l = layoutDefinition(
      def([
        { id: 'a', type: 'delay', params: {}, next: 'b' },
        { id: 'b', type: 'delay', params: {}, next: 'a' },
      ]),
    );
    expect(l.nodes).toHaveLength(2);
  });
  it('adds a step after the selected one and removes it with its links', () => {
    const base = starterDefinition();
    const a = addStep(base, 'delay', 'wait');
    expect(a.def.steps.find((s) => s.id === 'wait')?.next).toBe(a.id);
    const b = removeStep(a.def, a.id);
    expect(b.steps.find((s) => s.id === 'wait')?.next).toBeUndefined();
    const c = removeStep(base, 'prepare');
    expect(c.start).toBe('wait');
    expect(addStep(def([]), 'delay').def.start).toMatch(/^delay_/);
  });
  it('a loop step comes with a body, a condition gets its branches in order', () => {
    const l = addStep(def([]), 'loop');
    expect(l.def.steps[0]?.body?.length).toBe(1);
    const c = addStep(def([{ id: 'c', type: 'condition', params: { expr: 'x' } }]), 'delay', 'c');
    const d = addStep(c.def, 'delay', 'c');
    const cond = d.def.steps.find((s) => s.id === 'c')!;
    expect(cond.onTrue).toBe(c.id);
    expect(cond.onFalse).toBe(d.id);
  });
  it('renaming a step updates the links and the start', () => {
    const r = replaceStep(starterDefinition(), 'prepare', {
      ...starterDefinition().steps[0]!,
      id: 'first',
    });
    expect(r.start).toBe('first');
    const w = replaceStep(starterDefinition(), 'wait', {
      id: 'later',
      type: 'delay',
      params: { seconds: 5 },
    });
    expect(w.steps.find((s) => s.id === 'prepare')?.next).toBe('later');
  });
});

describe('reseller markup arithmetic (display only)', () => {
  it('parses percentages into basis points and keeps negatives negative', () => {
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('10')).toBe(1000);
    expect(percentToBps('0,5')).toBe(50);
    expect(percentToBps('-5')).toBe(-500);
    expect(percentToBps('abc')).toBeNull();
    expect(percentToBps('1.234')).toBeNull();
  });
  it('flags a negative markup as below cost', () => {
    expect(isBelowCost({ type: 'percent', bps: -1 })).toBe(true);
    expect(isBelowCost({ type: 'percent', bps: 0 })).toBe(false);
    expect(isBelowCost({ type: 'fixed', amountMinor: '-5', currency: 'SAR' })).toBe(true);
    expect(isBelowCost({ type: 'fixed', amountMinor: '5', currency: 'SAR' })).toBe(false);
  });
  it('computes retail = wholesale + markup with integers only', () => {
    expect(retailPreview('10000', { type: 'percent', bps: 1250 })).toBe('11250');
    expect(retailPreview('999', { type: 'percent', bps: 1000 })).toBe('1098');
    expect(retailPreview('10000', { type: 'fixed', amountMinor: '250', currency: 'SAR' })).toBe(
      '10250',
    );
    expect(marginPreview('10000', { type: 'percent', bps: 1250 })).toBe('1250');
    expect(retailPreview('1.5', { type: 'percent', bps: 1 })).toBeNull();
  });
  it('effective dates must be at least a day away', () => {
    const now = Date.parse('2027-01-10T12:00:00Z');
    expect(effectiveFromOk('2027-01-11', now)).toBe(false);
    expect(effectiveFromOk('2027-01-12', now)).toBe(true);
    expect(effectiveFromOk(defaultEffectiveFrom(now), now)).toBe(true);
  });
  it('statement period helpers', () => {
    expect(previousPeriod(Date.parse('2027-01-10T00:00:00Z'))).toBe('2026-12');
    expect(validPeriod('2026-12')).toBe(true);
    expect(validPeriod('2026-13')).toBe(false);
    expect(issuerBlocked({ status: 'disabled' })).toBe(true);
    expect(issuerBlocked({ status: 'BLOCKED' })).toBe(true);
  });
});

describe('agency grants', () => {
  const now = Date.parse('2027-01-10T12:00:00Z');
  it('the expiry is mandatory, in the future and at most 365 days away', () => {
    expect(checkExpiry('', now)).toBe('missing');
    expect(checkExpiry('soon', now)).toBe('invalid');
    expect(checkExpiry('2027-01-10', now)).toBe('ok');
    expect(checkExpiry('2027-01-09', now)).toBe('too_soon');
    expect(checkExpiry(dateIn(90, now), now)).toBe('ok');
    expect(checkExpiry(dateIn(364, now), now)).toBe('ok');
    expect(checkExpiry(dateIn(366, now), now)).toBe('too_far');
    expect(expiryOf('2027-04-10')).toBe('2027-04-10T23:59:59.000Z');
  });
  it('lists only clients with an active link and a live grant', () => {
    const link = (id: string, status: LinkDto['status']): LinkDto => ({
      id,
      agencyId: 'a',
      clientOrgId: id,
      status,
      acceptedAt: null,
      revokedAt: null,
      createdAt: '2027-01-01T00:00:00Z',
    });
    const grant = (
      client: string,
      status: GrantDto['status'],
      expiresAt: string,
      scopes = ['automation:read'],
    ): GrantDto => ({
      id: `${client}-${status}`,
      agencyId: 'a',
      clientOrgId: client,
      scopes,
      expiresAt,
      status,
      grantedAt: null,
      revokedAt: null,
      createdAt: '2027-01-01T00:00:00Z',
    });
    const r = actingClients(
      [link('c1', 'active'), link('c2', 'active'), link('c3', 'pending'), link('c4', 'active')],
      [
        grant('c1', 'active', '2027-06-01T00:00:00Z'),
        grant('c1', 'active', '2027-03-01T00:00:00Z', ['automation:run']),
        grant('c2', 'active', '2027-01-01T00:00:00Z'),
        grant('c3', 'active', '2027-06-01T00:00:00Z'),
        grant('c4', 'revoked', '2027-06-01T00:00:00Z'),
      ],
      now,
    );
    expect(r.map((x) => x.clientOrgId)).toEqual(['c1']);
    expect(r[0]?.scopes).toEqual(['automation:read', 'automation:run']);
    expect(r[0]?.expiresAt).toBe('2027-06-01T00:00:00Z');
  });
});

describe('formatting, problems and logs', () => {
  it('prices are shown from integer minor units', () => {
    expect(moneyText('4990', 'SAR', 'en').replace(/\s/g, ' ')).toBe('SAR 49.90');
    expect(moneyText('100', 'JPY', 'en')).toBe('100 JPY');
    expect(toMinor('49.90')).toBe('4990');
    expect(toMinor('50')).toBe('5000');
    expect(toMinor('0,5')).toBe('50');
    expect(toMinor('1.234')).toBeNull();
    expect(toMinor('-1')).toBeNull();
  });
  it('reads the errors[] of a 422 and maps known codes to plain text', () => {
    expect(
      issuesOf({
        errors: [{ code: 'cycle', path: '$.steps.a', message: 'loop' }, { field: 'name' }, 5],
      }),
    ).toEqual([
      { code: 'cycle', path: '$.steps.a', message: 'loop' },
      { code: 'invalid', path: 'name', message: '' },
    ]);
    expect(issuesOf(undefined)).toEqual([]);
    const p = problemOf({ response: { status: 422 }, error: { code: 'below_cost' } });
    expect(m11Error('en', p).text).toContain('below the wholesale cost');
    const u = problemOf({
      response: { status: 422 },
      error: { code: 'unsupported_capability', detail: 'builder not wired' },
    });
    expect(m11Error('en', u).detail).toBe('builder not wired');
    expect(
      m11Error(
        'ar',
        problemOf({ response: { status: 403 }, error: { code: 'publisher_not_verified' } }),
      ).text,
    ).toContain('الناشر');
  });
  it('masks credential-looking keys again before showing a log', () => {
    expect(
      maskSecrets({
        url: 'https://x.example',
        headers: { Authorization: 'Bearer abc', accept: 'json' },
        nested: [{ api_key: 'k' }],
      }),
    ).toEqual({
      url: 'https://x.example',
      headers: { Authorization: '[redacted]', accept: 'json' },
      nested: [{ api_key: '[redacted]' }],
    });
  });
  it('groups attempts by step and orders them; durations', () => {
    const s = (stepKey: string, attempt: number) => ({
      stepKey,
      attempt,
      status: 'failed',
      idempotent: true,
      input: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    const g = groupAttempts([s('a', 2), s('b', 1), s('a', 1)]);
    expect(g.map((x) => x.key)).toEqual(['a', 'b']);
    expect(g[0]?.attempts.map((x) => x.attempt)).toEqual([1, 2]);
    expect(durationMs('2027-01-01T00:00:00Z', '2027-01-01T00:00:02Z')).toBe(2000);
    expect(durationMs(null, '2027-01-01T00:00:02Z')).toBeNull();
  });
});
