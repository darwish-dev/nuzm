import { describe, expect, it } from 'vitest';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { validateAppSpec, type AppSpec } from './app-spec';

const clone = (): AppSpec => JSON.parse(JSON.stringify(SAMPLE_SPEC)) as AppSpec;
const issues = (s: unknown) =>
  validateAppSpec(s)
    .issues.map((i) => `${i.path} ${i.message}`)
    .join(' | ');

describe('application spec validation', () => {
  it('accepts the sample spec', () => {
    expect(validateAppSpec(SAMPLE_SPEC)).toEqual({ ok: true, issues: [] });
  });
  it('rejects unknown properties and bad identifiers (schema)', () => {
    const s = clone() as unknown as Record<string, unknown>;
    s.extra = 1;
    (s.entities as { name: string }[])[0]!.name = 'bad name';
    expect(issues(s)).toMatch(/\$\.extra is not allowed/);
    expect(issues(s)).toMatch(/entities\[0\]\.name/);
  });
  it('rejects dangling references, unknown roles/entities, duplicates and reserved words', () => {
    const s = clone();
    s.entities[1]!.fields[3]!.references = 'Ghost';
    s.roles[1]!.permissions.Nope = ['read'];
    s.pages[1]!.path = '/projects';
    s.entities[0]!.plural = 'select';
    s.entities[0]!.fields.push({ name: 'orgId', type: 'string', labels: { ar: 'س', en: 'x' } });
    const m = issues(s);
    expect(m).toMatch(/unknown entity Ghost/);
    expect(m).toMatch(/unknown entity Nope/);
    expect(m).toMatch(/duplicate page \/projects/);
    expect(m).toMatch(/reserved identifier/);
    expect(m).toMatch(/reserved column name/);
  });
  it('requires an admin role, a stage enum for a board and enum values', () => {
    const s = clone();
    s.roles.forEach((r) => delete r.admin);
    s.entities[1]!.stageField = 'title';
    s.entities[0]!.fields[1]!.enumValues = undefined;
    const m = issues(s);
    expect(m).toMatch(/administrator role/);
    expect(m).toMatch(/stage field must be an enum/);
    expect(m).toMatch(/enum field needs values/);
  });

  it('sends back dashboard widgets the runtime would silently leave empty', () => {
    const s = clone();
    const dash = s.pages.find((p) => p.path === '/')!;
    const project = s.entities.find((e) => !e.stageField)!;
    dash.widgets = [
      { id: 'w1', kind: 'sum', entity: 'Task', field: 'title', title: { ar: 'م', en: 'S' } },
      { id: 'w1', kind: 'by_stage', entity: project.name, title: { ar: 'م', en: 'B' } },
    ];
    const out = issues(s);
    expect(out).toContain('a sum widget needs a decimal or integer field of Task');
    expect(out).toContain('duplicate widget w1');
    expect(out).toContain(`${project.name} has no stage field for a by_stage widget`);
  });
});
