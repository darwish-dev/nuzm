import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@nuzm/sdk';
import {
  actionAllowed,
  apiCall,
  capabilitySet,
  flagOn,
  isImageId,
  isInstanceName,
  isQuoteExpired,
  isTransient,
  isUncertain,
  moneyText,
  parseDiskGb,
  parseOfferFilters,
  parseSshKeys,
  problemKey,
  problemOf,
  provisioningHint,
  queryString,
  readSeries,
  residencyOf,
  secondsLeft,
  statusTone,
  timelineOf,
  unwrapCall,
  visibleActions,
  windowRange,
  type CallEnv,
  type OperationView,
} from './compute';

describe('money display (integer minor units, never floats)', () => {
  it('formats SAR in both locales without losing precision', () => {
    expect(moneyText('12345', 'SAR', 'en')).toContain('123.45');
    expect(moneyText('12345', 'SAR', 'ar')).toMatch(/123[.٫]45|١٢٣[.٫]٤٥/);
  });
  it('falls back to string arithmetic for a currency the formatter does not know', () => {
    expect(moneyText('5', 'KWD', 'en')).toBe('0.05 KWD');
    expect(moneyText('100000000000000000005', 'KWD', 'en')).toBe('1000000000000000000.05 KWD');
    expect(moneyText('abc', 'KWD', 'en')).toBe('— KWD');
  });
});

describe('offer filters', () => {
  it('accepts valid filters and normalises the country', () => {
    expect(
      parseOfferFilters({
        country: 'sa',
        geoGroup: 'in_kingdom',
        minVcpu: '2',
        minMemoryMb: '4096',
      }),
    ).toEqual({
      filters: { country: 'SA', geoGroup: 'in_kingdom', minVcpu: 2, minMemoryMb: 4096 },
      errors: {},
    });
  });
  it('drops and reports invalid entries instead of sending them', () => {
    const r = parseOfferFilters({
      country: 'SAU',
      geoGroup: 'EU!',
      minVcpu: '0',
      minMemoryMb: '1.5',
    });
    expect(r.filters).toEqual({});
    expect(r.errors).toEqual({ country: true, geoGroup: true, minVcpu: true, minMemoryMb: true });
  });
  it('treats empty and array params like the first value', () => {
    expect(parseOfferFilters({ country: '', minVcpu: ['4', '8'] }).filters).toEqual({ minVcpu: 4 });
  });
  it('builds a query string without empty values', () => {
    expect(queryString({ country: 'SA', cursor: undefined, minVcpu: 2, x: '' })).toBe(
      '?country=SA&minVcpu=2',
    );
    expect(queryString({})).toBe('');
  });
});

describe('capability-based actions', () => {
  it('shows only the actions in the capability set (both id spellings)', () => {
    expect(visibleActions(['compute.action.start', 'stop', 'compute.metrics'])).toEqual([
      'start',
      'stop',
    ]);
    expect(visibleActions([])).toEqual([]);
    expect(visibleActions(undefined)).toEqual([]);
    expect(capabilitySet(['compute.metrics', 'compute.action.snapshot'])).toEqual(
      new Set(['metrics', 'snapshot']),
    );
  });
  it('allows an action only in a matching state', () => {
    expect(actionAllowed('start', 'stopped')).toBe(true);
    expect(actionAllowed('start', 'running')).toBe(false);
    expect(actionAllowed('stop', 'running')).toBe(true);
    expect(actionAllowed('reboot', 'stopped')).toBe(false);
    expect(actionAllowed('snapshot', 'stopped')).toBe(true);
    expect(actionAllowed('resize', 'provisioning')).toBe(false);
  });
});

describe('instance state', () => {
  it('flags UNKNOWN / needs_reconcile / drift as uncertain', () => {
    expect(isUncertain('unknown')).toBe(true);
    expect(isUncertain('UNKNOWN')).toBe(true);
    expect(isUncertain('running', 'needs_reconcile')).toBe(true);
    expect(isUncertain('running', 'running', 'missing')).toBe(true);
    expect(isUncertain('running', 'succeeded', 'in_sync')).toBe(false);
    expect(isUncertain('failed')).toBe(false);
  });
  it('maps statuses to tones and transient states', () => {
    expect(statusTone('running')).toBe('success');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('provisioning')).toBe('warn');
    expect(isTransient('deleting')).toBe(true);
    expect(isTransient('running')).toBe(false);
  });
  it('reads feature flags strictly (only literal true is on)', () => {
    expect(flagOn({ 'cloud.provisioning': true }, 'cloud.provisioning')).toBe(true);
    expect(flagOn({ 'cloud.provisioning': 'true' }, 'cloud.provisioning')).toBe(false);
    expect(flagOn({}, 'cloud.provisioning')).toBe(false);
    expect(flagOn(null, 'x')).toBe(false);
  });
});

describe('operation timeline', () => {
  const base: OperationView = {
    id: 'op1',
    kind: 'compute.instance.create',
    state: 'needs_reconcile',
    attempts: 3,
    cancelRequested: false,
    createdAt: '2026-11-18T10:00:00Z',
    updatedAt: '2026-11-18T10:05:00Z',
    error: { code: 'provider_timeout', detail: 'raw provider wording must never be shown' },
    result: {
      steps: [
        { name: 'reserve_authorization', state: 'succeeded', at: '2026-11-18T10:00:01Z' },
        { nope: 1 },
      ],
    },
  };
  it('lists created, steps, attempts, error code and the current state', () => {
    const tl = timelineOf(base);
    expect(tl.map((e) => e.kind)).toEqual(['created', 'step', 'attempts', 'error', 'state']);
    expect(tl.find((e) => e.kind === 'error')?.value).toBe('provider_timeout');
    expect(JSON.stringify(tl)).not.toContain('raw provider wording');
    expect(tl.at(-1)).toMatchObject({ kind: 'state', value: 'needs_reconcile', tone: 'warn' });
  });
  it('is minimal for a fresh operation', () => {
    const tl = timelineOf({
      ...base,
      attempts: 1,
      error: undefined,
      result: undefined,
      state: 'running',
    });
    expect(tl.map((e) => e.kind)).toEqual(['created', 'state']);
  });
});

describe('wizard input', () => {
  const ed =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host';
  it('accepts public keys and reports the invalid line numbers', () => {
    expect(parseSshKeys(`${ed}\n\n${ed}`)).toEqual({ keys: [ed], invalid: [] });
    const r = parseSshKeys(`${ed}\n-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nnot a key`);
    expect(r.keys).toEqual([ed]);
    expect(r.invalid).toEqual([2, 3]);
  });
  it('validates names, image ids and disk size', () => {
    expect(isInstanceName('web-01')).toBe(true);
    expect(isInstanceName('-bad')).toBe(false);
    expect(isInstanceName('a'.repeat(64))).toBe(false);
    expect(isInstanceName('has space')).toBe(false);
    expect(isImageId('ubuntu-22.04')).toBe(true);
    expect(isImageId('bad id')).toBe(false);
    expect(isImageId('')).toBe(false);
    expect(parseDiskGb('')).toBeUndefined();
    expect(parseDiskGb('80')).toBe(80);
    expect(parseDiskGb('0')).toBeNull();
    expect(parseDiskGb('8.5')).toBeNull();
  });
  it('knows when a quote expired', () => {
    const t0 = Date.parse('2026-11-18T10:00:00Z');
    expect(isQuoteExpired('2026-11-18T10:15:00Z', t0)).toBe(false);
    expect(isQuoteExpired('2026-11-18T10:15:00Z', t0 + 15 * 60_000)).toBe(true);
    expect(secondsLeft('2026-11-18T10:15:00Z', t0)).toBe(900);
    expect(secondsLeft('2026-11-18T10:15:00Z', t0 + 99 * 60_000)).toBe(0);
  });
  it('normalises the residency result of a quote', () => {
    expect(
      residencyOf({ residency: { decision: 'allow', policyVersion: 3, dataRegion: 'in_kingdom' } }),
    ).toEqual({
      verdict: 'allowed',
      raw: 'allow',
      policyVersion: '3',
      dataRegion: 'in_kingdom',
    });
    expect(residencyOf({ residency: { decision: 'deny' } }).verdict).toBe('denied');
    expect(residencyOf({ residency: { status: 'not_evaluated' } }).verdict).toBe('not_evaluated');
    expect(residencyOf({ residency: { decision: 'review' } }).verdict).toBe('other');
  });
});

describe('metrics and approvals helpers', () => {
  it('narrows loosely typed series', () => {
    expect(
      readSeries([
        { name: 'cpu', unit: '%', points: [{ value: 1 }, { value: 3 }, { v: 2 }, { value: 'x' }] },
        { metric: 'mem', points: [[1, 5]] },
        { points: [] },
        'junk',
      ]),
    ).toEqual([
      { name: 'cpu', unit: '%', points: 3, latest: 2, min: 1, max: 3 },
      { name: 'mem', unit: undefined, points: 1, latest: 5, min: 5, max: 5 },
    ]);
    expect(readSeries(undefined)).toEqual([]);
  });
  it('builds the window from the clock', () => {
    const now = new Date('2026-11-18T10:00:00Z');
    expect(windowRange('1h', now)).toEqual({
      from: '2026-11-18T09:00:00.000Z',
      to: '2026-11-18T10:00:00.000Z',
    });
    expect(windowRange('7d', now).from).toBe('2026-11-11T10:00:00.000Z');
  });
  it('recognises a compute quote behind a spend approval', () => {
    expect(
      provisioningHint({
        kind: 'compute',
        totalMinor: '4500',
        currency: 'SAR',
        items: [{ description: '2 vCPU' }],
      }),
    ).toEqual({ summary: '2 vCPU', totalMinor: '4500', currency: 'SAR' });
    expect(
      provisioningHint({ kind: 'ai-credit', totalMinor: '1', currency: 'SAR', items: [] }),
    ).toBeNull();
    expect(provisioningHint({ kind: 'compute', totalMinor: '1.5', currency: 'SAR' })).toBeNull();
    expect(provisioningHint(null)).toBeNull();
  });
});

describe('problem mapping', () => {
  it.each([
    ['quote_expired', 409, 'm05.web.err.quote_expired'],
    ['quote_consumed', 409, 'm05.web.err.quote_consumed'],
    ['price_changed', 409, 'm05.web.err.price_changed'],
    ['spend_approval_required', 422, 'm05.web.err.spend_approval_required'],
    ['residency_denied', 403, 'm05.web.err.residency_denied'],
    ['quota_exceeded', 422, 'm05.web.err.quota_exceeded'],
    ['unsupported_capability', 422, 'm05.web.err.unsupported_capability'],
    ['invalid_state', 409, 'm05.web.err.invalid_state'],
    ['deletion_protected', 409, 'm05.web.err.deletion_protected'],
    ['no_eligible_offer', 422, 'm05.web.err.no_eligible_offer'],
    ['network_error', 599, 'm05.web.err.network'],
  ])('%s (%s) → %s', (code, status, key) => expect(problemKey({ code, status })).toBe(key));
  it('falls back by status for an unknown code', () => {
    expect(problemKey({ status: 412, code: 'precondition_failed' })).toBe('m05.web.err.stale');
    expect(problemKey({ status: 428 })).toBe('m05.web.err.stale');
    expect(problemKey({ status: 429 })).toBe('m05.web.err.rate_limited');
    expect(problemKey({ status: 403 })).toBe('state.forbidden.title');
    expect(problemKey({ status: 500 })).toBe('state.error.title');
  });
});

describe('fetch wrapper', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const env = (f: typeof fetch): CallEnv => ({
    baseUrl: 'http://api',
    headers: () => ({ 'x-nuzm-org': 'org1', 'x-csrf-token': 'tok' }),
    fetch: f,
  });

  it('sends idempotency key, If-Match, JSON body and selectors; parses the answer', async () => {
    const f = vi.fn(async () => json(202, { operationId: 'op' }));
    const r = await apiCall<{ operationId: string }>(
      env(f as unknown as typeof fetch),
      'DELETE',
      '/v1/compute/instances/1',
      {
        ifMatch: '"3"',
        idempotencyKey: 'k1',
        query: { a: 1 },
      },
    );
    expect(r.data).toEqual({ operationId: 'op' });
    const [url, init] = f.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('http://api/v1/compute/instances/1?a=1');
    expect(init.method).toBe('DELETE');
    expect(init.headers['idempotency-key']).toBe('k1');
    expect(init.headers['if-match']).toBe('"3"');
    expect(init.headers['x-nuzm-org']).toBe('org1');
    expect(init.body).toBeUndefined();
  });
  it('returns the problem body on an error, with the approval id', async () => {
    const f = async () =>
      json(422, { code: 'spend_approval_required', approvalId: 'ap1', traceId: 'tr' });
    const r = await apiCall(env(f as unknown as typeof fetch), 'POST', '/v1/compute/instances', {
      body: { quoteId: 'q' },
    });
    expect(r.response.ok).toBe(false);
    expect(problemOf(r)).toEqual({
      status: 422,
      code: 'spend_approval_required',
      approvalId: 'ap1',
      traceId: 'tr',
    });
  });
  it('turns a network failure into an uncertain 599 result instead of throwing', async () => {
    const f = async () => {
      throw new TypeError('fetch failed');
    };
    const r = await apiCall(env(f as unknown as typeof fetch), 'POST', '/v1/quotes');
    expect(r.response.status).toBe(599);
    expect(problemOf(r).code).toBe('network_error');
  });
  it('unwrapCall throws an ApiError the shared view() understands', async () => {
    const f = async () => json(404, { code: 'not_found' });
    await expect(
      unwrapCall(apiCall(env(f as unknown as typeof fetch), 'GET', '/v1/offers')),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      unwrapCall(apiCall(env(f as unknown as typeof fetch), 'GET', '/v1/offers')),
    ).rejects.toMatchObject({ status: 404, isNotFound: true });
    const ok = async () => json(200, { items: [] });
    await expect(
      unwrapCall(apiCall(env(ok as unknown as typeof fetch), 'GET', '/v1/offers')),
    ).resolves.toEqual({ items: [] });
  });
});
