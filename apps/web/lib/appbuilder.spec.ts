import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ROLES,
  APPROVAL_TYPES,
  approvalLapsed,
  approvalsOf,
  buildPatch,
  buildTree,
  builderError,
  decisionErrorKey,
  diffOf,
  downloadValid,
  fieldProblems,
  healthOf,
  isIsolated,
  isLiveRun,
  maskSecrets,
  meterLevel,
  minorToSar,
  percentUsed,
  problemOf,
  runMeters,
  runWarns,
  safeHref,
  safeRelPath,
  safeText,
  sarToMinor,
  settle,
  splitNames,
  summaryOf,
  validateBudget,
} from './appbuilder';

const run = (tokens: number, cost: number, minutesLeft: number) =>
  ({
    budget: { maxTokens: 1000, maxCostMinor: 5000, maxMinutes: 30 },
    usage: { tokensIn: tokens, tokensOut: 0, costMinor: cost, steps: 1 },
    budgetRemaining: {
      tokens: 1000 - tokens,
      costMinor: 5000 - cost,
      minutes: minutesLeft,
      steps: 10,
    },
  }) as never;

describe('money and budget input (integer minor units, no floats)', () => {
  it('converts SAR text to halalas', () => {
    expect(sarToMinor('500')).toBe(50000);
    expect(sarToMinor('12.5')).toBe(1250);
    expect(sarToMinor('12.50')).toBe(1250);
    expect(sarToMinor('0.05')).toBe(5);
    for (const bad of ['', '0', '-1', '1.234', 'abc', '1e3', '1.2.3'])
      expect(sarToMinor(bad)).toBeNull();
    expect(minorToSar(50000)).toBe('500.00');
    expect(minorToSar(5)).toBe('0.05');
  });
  it('holds tokens and minutes to the ceilings', () => {
    expect(validateBudget({ tokens: '2000000', cost: '10', minutes: '60' })).toEqual({
      ok: true,
      budget: { maxTokens: 2_000_000, maxCostMinor: 1000, maxMinutes: 60 },
    });
    const bad = validateBudget({ tokens: '2000001', cost: '0', minutes: '61' });
    expect(bad).toEqual({
      ok: false,
      errors: {
        tokens: 'm10.wiz.err.tokens',
        cost: 'm10.wiz.err.cost',
        minutes: 'm10.wiz.err.minutes',
      },
    });
  });
  it('splits one name per line, de-duplicated', () => {
    expect(splitNames('Customer\n customer \nInvoice,\n\nمدير،موظف')).toEqual([
      'Customer',
      'Invoice',
      'مدير',
      'موظف',
    ]);
  });
});

describe('budget meter', () => {
  it('warns from 80 % and flags 100 %', () => {
    expect(percentUsed(79, 100)).toBe(79);
    expect(meterLevel(79)).toBe('ok');
    expect(meterLevel(80)).toBe('warn');
    expect(meterLevel(100)).toBe('exceeded');
    expect(percentUsed(5, 0)).toBe(0);
  });
  it('derives minutes used from the remaining figure', () => {
    const m = runMeters(run(100, 100, 6));
    expect(m.find((x) => x.key === 'minutes')).toMatchObject({
      used: 24,
      max: 30,
      pct: 80,
      level: 'warn',
    });
    expect(runWarns(run(100, 100, 6))).toBe(true);
    expect(runWarns(run(100, 100, 29))).toBe(false);
  });
  it('knows the live states', () => {
    expect(['queued', 'running', 'waiting_approval'].every(isLiveRun)).toBe(true);
    expect(['succeeded', 'failed', 'cancelled', 'budget_exceeded'].some(isLiveRun)).toBe(false);
  });
});

describe('secrets never reach the screen', () => {
  it('masks secret-named keys and token-like text', () => {
    expect(
      maskSecrets({ path: 'a.ts', apiKey: 'x', nested: { Authorization: 'Bearer abc', ok: 1 } }),
    ).toEqual({
      path: 'a.ts',
      apiKey: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', ok: 1 },
    });
    expect(safeText('key is sk_live_abcdefghijklmnopqrstuvwxyz0123 ok')).toBe(
      'key is [REDACTED] ok',
    );
  });
  it('field problems keep only path and masked message', () => {
    expect(
      fieldProblems({
        errors: [
          {
            path: 'patches[0].content',
            message: 'secret pattern aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          7,
        ],
      }),
    ).toEqual([{ field: 'patches[0].content', message: 'secret pattern [REDACTED]' }]);
  });
});

describe('errors', () => {
  const p = (status: number, code?: string, detail?: string) =>
    problemOf({ response: { status }, error: { code, detail } });
  it('maps the documented codes to plain language', () => {
    expect(builderError('en', p(402, 'budget_required')).text).toMatch(/budget or credit/i);
    expect(builderError('en', p(409, 'sandbox_quota_exceeded')).text).toMatch(/maximum number/i);
    expect(builderError('en', p(503, 'sandbox_no_capacity')).text).toMatch(/capacity/i);
    expect(builderError('en', p(409, 'base_mismatch')).text).toMatch(/changed/i);
    expect(builderError('ar', p(409, 'base_mismatch')).text).toMatch(/[\u0600-\u06ff]/);
    expect(builderError('en', p(404)).text).toMatch(/not enabled/i);
    expect(builderError('en', p(0)).text).toMatch(/Cannot reach/i);
  });
  it('shows the reason of an unsupported capability, masked', () => {
    const e = builderError('en', p(422, 'unsupported_capability', 'mobile is M10B'));
    expect(e.detail).toBe('mobile is M10B');
  });
  it('decision errors: stale hash, expired, role', () => {
    expect(decisionErrorKey(409, 'stale_approval_hash')).toBe('m10.apr.err.stale');
    expect(decisionErrorKey(410, 'gone')).toBe('m10.apr.err.expired');
    expect(decisionErrorKey(403, 'forbidden')).toBe('m10.apr.err.role');
  });
  it('reads the approvals of a 403 approval_required', () => {
    expect(
      approvalsOf({
        approvals: [{ id: 'a', type: 'production_deploy', scopeHash: 'h' }, { id: 1 }, null],
      }),
    ).toEqual([{ id: 'a', type: 'production_deploy', scopeHash: 'h' }]);
    expect(approvalsOf(undefined)).toEqual([]);
  });
  it('settle turns a network failure into status 0', async () => {
    const r = await settle(() => Promise.reject(new TypeError('failed to fetch')));
    expect(r.response.status).toBe(0);
  });
});

describe('approvals', () => {
  it('lists every type with its deciding roles (M10 §9)', () => {
    expect(APPROVAL_TYPES).toHaveLength(10);
    expect(APPROVAL_ROLES.release_owner).toEqual(['owner']);
    expect(APPROVAL_ROLES.egress_or_dependency).toEqual(['owner', 'admin', 'developer']);
    expect(APPROVAL_ROLES.paid_resource).toContain('billing_admin');
    expect(APPROVAL_ROLES.production_deploy).toEqual(['owner', 'admin']);
  });
  it('a pending approval past its expiry is lapsed', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(approvalLapsed({ status: 'pending', expiresAt: '2026-11-18T11:59:00Z' }, now)).toBe(
      true,
    );
    expect(approvalLapsed({ status: 'pending', expiresAt: '2026-11-19T11:59:00Z' }, now)).toBe(
      false,
    );
    expect(approvalLapsed({ status: 'approved', expiresAt: '2026-11-18T11:59:00Z' }, now)).toBe(
      false,
    );
  });
});

describe('sandbox honesty', () => {
  it('only verified isolation is isolated', () => {
    expect(isIsolated({ kind: 'isolated', isolation: 'verified' })).toBe(true);
    for (const i of ['none', 'simulated', undefined])
      expect(isIsolated({ kind: 'mock', isolation: i })).toBe(false);
    expect(isIsolated(undefined)).toBe(false);
  });
});

describe('changes', () => {
  it('accepts only safe relative paths', () => {
    for (const ok of ['src/a.ts', 'README.md']) expect(safeRelPath(ok)).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a'])
      expect(safeRelPath(bad)).toBe(false);
  });
  it('builds the patch with the hash the operation needs', () => {
    const h = 'a'.repeat(64);
    expect(
      buildPatch({ op: 'modify', path: 'src/a.ts', content: 'x', from: '', expectedHash: h }),
    ).toEqual({
      ok: true,
      patch: { op: 'modify', path: 'src/a.ts', content: 'x', expectedHash: h },
    });
    expect(
      buildPatch({ op: 'add', path: 'src/n.ts', content: 'x', from: '', expectedHash: '' }),
    ).toEqual({
      ok: true,
      patch: { op: 'add', path: 'src/n.ts', content: 'x' },
    });
    expect(
      buildPatch({ op: 'modify', path: 'src/a.ts', content: 'x', from: '', expectedHash: 'zz' }),
    ).toEqual({
      ok: false,
      errors: { expectedHash: 'm10.chg.err.hash' },
    });
    expect(
      buildPatch({ op: 'rename', path: 'b.ts', content: '', from: '../a.ts', expectedHash: h }),
    ).toMatchObject({
      ok: false,
      errors: { from: 'm10.chg.err.from' },
    });
  });
  it('reads a diff without trusting its shape', () => {
    expect(diffOf({ added: ['a'], modified: 3, renamed: [{ from: 'x', to: 'y' }, 1] })).toEqual({
      added: ['a'],
      modified: [],
      deleted: [],
      renamed: [{ from: 'x', to: 'y' }],
    });
    expect(diffOf(null).added).toEqual([]);
  });
  it('builds a file tree, directories first', () => {
    const t = buildTree([
      { path: 'b.txt' },
      { path: 'src/z.ts' },
      { path: 'src/a.ts' },
      { path: '../evil' },
    ]);
    expect(t.map((n) => n.name)).toEqual(['src', 'b.txt']);
    expect(t[0]!.children.map((n) => n.name)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('test results, deployments, exports', () => {
  it('reads structured results with failed cases first', () => {
    const s = summaryOf({
      totals: { suites: 1, tests: 2, failures: 1, skipped: 0 },
      suites: [
        {
          suite: 'unit',
          status: 'failed',
          tests: 2,
          failures: 1,
          skipped: 0,
          cases: [
            { suite: 'unit', name: 'adds', status: 'failed', failure: 'expected 3' },
            { suite: 'unit', name: 'ok', status: 'passed' },
          ],
        },
      ],
    });
    expect(s.totals.failures).toBe(1);
    expect(s.failed).toEqual([
      { suite: 'unit', name: 'adds', status: 'failed', failure: 'expected 3' },
    ]);
    expect(summaryOf(undefined).suites).toEqual([]);
  });
  it('reads the health gate', () => {
    expect(healthOf({})).toBeNull();
    expect(
      healthOf({ attempts: 3, autoRolledBack: true, restoredDeploymentId: 'abc' }),
    ).toMatchObject({ attempts: 3, autoRolledBack: true });
  });
  it('offers a download only while the signed URL is valid and http(s)', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(
      downloadValid(
        { downloadUrl: 'https://x/y', downloadUrlExpiresAt: '2026-11-18T12:10:00Z' },
        now,
      ),
    ).toBe(true);
    expect(
      downloadValid(
        { downloadUrl: 'https://x/y', downloadUrlExpiresAt: '2026-11-18T11:59:00Z' },
        now,
      ),
    ).toBe(false);
    expect(
      downloadValid({ downloadUrl: null, downloadUrlExpiresAt: '2026-11-18T12:10:00Z' }, now),
    ).toBe(false);
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c');
  });
});
