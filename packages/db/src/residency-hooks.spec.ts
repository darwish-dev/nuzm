import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterKindsFromDocs } from './ropa-coverage';
import { evaluateHooks, loadHookRegistry, type HookRegistry } from './residency-hooks';

const root = join(__dirname, '../../..');
const reg = loadHookRegistry(join(root, 'spec/compliance/residency-hooks.yaml'));
const kinds = adapterKindsFromDocs(
  readFileSync(join(root, 'docs/09-provider-adapter-interfaces.md'), 'utf8'),
);
const tables = Object.keys(reg.tables);
/** Reads a call-site file from the repository (null when it does not exist): enforced hooks must name real files. */
const none = (path: string) => {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
};
const kindsOf = (r: HookRegistry) =>
  evaluateHooks(r, tables, kinds, none).map((x) => `${x.kind} ${x.object}`);
const clone = (): HookRegistry => JSON.parse(JSON.stringify(reg)) as HookRegistry;

describe('the committed residency hook registry (AC-M04-14)', () => {
  it('is clean: every data_region table and adapter kind is covered, M05..M12 list hooks, nothing is enforced without a call site', () => {
    expect(evaluateHooks(reg, tables, kinds, none)).toEqual([]);
  });
  it('lists hooks for every milestone M05..M12 and every adapter kind of docs/09', () => {
    for (const m of ['M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'])
      expect(
        reg.hooks.some((h) => h.milestone === m),
        m,
      ).toBe(true);
    expect(kinds).toHaveLength(11);
    for (const k of kinds)
      expect(
        reg.hooks.some((h) => h.processor_kind === k),
        k,
      ).toBe(true);
  });
  it('enforces only what an owner milestone has built (M05 S17 offers/quotes and provisioning, M06 node selection and backup sink, M08 data/email placement); the rest is required, owned by its milestone and not yet built', () => {
    expect(
      reg.hooks
        .filter((h) => h.enforcement === 'enforced')
        .map((h) => h.id)
        .sort(),
    ).toEqual([
      'm05-offers-quote',
      'm05-provisioning',
      'm06-backup-sink',
      'm06-node-selection',
      'm07-registrant-contacts',
      'm08-cache-placement',
      'm08-data-placement',
      'm08-mailbox',
      'm08-object-storage',
      'm08-transactional-email',
      'm09-model-gateway',
    ]);
    expect(reg.hooks.filter((h) => h.enforcement === 'exempt').map((h) => h.id)).toEqual([
      'm03-zatca-submission',
    ]);
  });
});

describe('hook registry rules', () => {
  it('a table with a data_region column and no registration fails', () => {
    expect(
      evaluateHooks(reg, [...tables, 'mobile.builds'], kinds, none).map(
        (x) => `${x.kind} ${x.object}`,
      ),
    ).toEqual(['table_without_hook mobile.builds']);
  });
  it('a registered table that no longer has the column, and an unknown hook, fail', () => {
    const r = clone();
    r.tables['gone.table'] = { owner: 'M05', hook: 'm05-provisioning' };
    r.tables['invoicing.invoices']!.hook = 'm03-nothing';
    expect(kindsOf(r)).toEqual(
      expect.arrayContaining(['stale_table gone.table', 'unknown_hook invoicing.invoices']),
    );
  });
  it('an enforced hook needs a call site that really calls the residency service', () => {
    const r = clone();
    r.hooks[0]!.enforcement = 'enforced';
    r.hooks[0]!.call_site = 'apps/api/src/x.ts';
    expect(evaluateHooks(r, tables, kinds, none).map((x) => x.kind)).toEqual([
      'enforced_without_call_site',
    ]);
    expect(
      evaluateHooks(r, tables, kinds, () => 'await assertResidency(this.residency, req)').filter(
        (x) => x.kind === 'enforced_without_call_site',
      ),
    ).toEqual([]);
    // a file without the marker fails too (only the hook under test is looked at: the real M05 hooks are enforced as well)
    expect(
      evaluateHooks(r, tables, kinds, () => 'export const x = 1')
        .filter((x) => x.object === r.hooks[0]!.id)
        .map((x) => x.kind),
    ).toEqual(['enforced_without_call_site']);
  });
  it('an exempt hook needs its reason', () => {
    const r = clone();
    r.hooks.find((h) => h.enforcement === 'exempt')!.exempt_reason = 'x';
    expect(kindsOf(r)).toContain('exempt_without_reason m03-zatca-submission');
  });
  it('removing the only hook of a milestone or an adapter kind fails', () => {
    const r = clone();
    r.hooks = r.hooks.filter((h) => h.milestone !== 'M07');
    r.tables = {};
    const k = evaluateHooks(r, [], kinds, none).map((x) => `${x.kind} ${x.object}`);
    expect(k).toEqual(
      expect.arrayContaining(['milestone_without_hook M07', 'adapter_kind_without_hook registrar']),
    );
  });
  it('duplicate and malformed hooks fail', () => {
    const r = clone();
    r.hooks.push({ ...r.hooks[0]! }, { ...r.hooks[1]!, id: 'BAD ID' });
    const k = kindsOf(r);
    expect(k).toContain(`duplicate_hook ${r.hooks[0]!.id}`);
    expect(k).toContain('bad_hook BAD ID');
  });
  it('an id must start with its milestone', () => {
    const r = clone();
    r.hooks[3]!.id = 'm09-wrongly-named';
    expect(kindsOf(r).some((x) => x.startsWith('bad_hook m09-wrongly-named'))).toBe(true);
  });
});
