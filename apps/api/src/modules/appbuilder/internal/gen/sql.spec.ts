import { describe, expect, it } from 'vitest';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import type { AppSpec } from '../spec/app-spec';
import { detectDestructive, diffSpecs, initialMigration } from './sql';

const clone = (): AppSpec => JSON.parse(JSON.stringify(SAMPLE_SPEC)) as AppSpec;

describe('generated schema', () => {
  it('creates tables, platform tables, foreign keys after all tables, indexes; the down script drops everything', () => {
    const m = initialMigration(SAMPLE_SPEC);
    expect(m.up).toMatch(/CREATE TABLE "projects"/);
    expect(m.up).toMatch(/CREATE TABLE "tasks"/);
    expect(m.up).toMatch(/"assignee_email" varchar\(254\) CHECK/);
    expect(m.up.indexOf('CREATE TABLE "tasks"')).toBeLessThan(m.up.indexOf('FOREIGN KEY'));
    expect(m.up).toMatch(/CREATE TRIGGER "audit_log_no_change"/);
    expect(m.down).toMatch(/DROP TABLE IF EXISTS "tasks" CASCADE/);
    expect(m.destructive).toEqual([]);
  });
});
describe('migration diff (expand/contract)', () => {
  it('additive changes: new entity, nullable column, widened enum are expand-only and non-destructive', () => {
    const n = clone();
    n.entities[1]!.fields.push({
      name: 'notes',
      type: 'text',
      labels: { ar: 'ملاحظات', en: 'Notes' },
    });
    n.entities[1]!.fields[1]!.enumValues!.push('Blocked');
    n.entities.push({
      name: 'Label',
      plural: 'labels',
      labels: { ar: 'وسم', en: 'Label' },
      ownership: 'org',
      audit: false,
      searchable: [],
      sortable: [],
      fields: [{ name: 'title', type: 'string', labels: { ar: 'ع', en: 'T' }, required: true }],
    });
    const ms = diffSpecs(SAMPLE_SPEC, n, 2);
    expect(ms.map((m) => m.phase)).toEqual(['expand']);
    expect(ms[0]!.destructive).toEqual([]);
    expect(ms[0]!.up).toMatch(/ADD COLUMN "notes" text/);
    expect(ms[0]!.up).toMatch(/CREATE TABLE "labels"/);
    expect(ms[0]!.down).toMatch(/DROP TABLE IF EXISTS "labels"/);
  });
  it('a new REQUIRED column is added nullable (expand) and tightened in a separate contract migration', () => {
    const n = clone();
    n.entities[1]!.fields.push({
      name: 'priority',
      type: 'integer',
      required: true,
      labels: { ar: 'أولوية', en: 'Priority' },
    });
    const ms = diffSpecs(SAMPLE_SPEC, n, 2);
    expect(ms.map((m) => m.phase)).toEqual(['expand', 'contract']);
    expect(ms[0]!.up).toMatch(/ADD COLUMN "priority" bigint;/);
    expect(ms[1]!.up).toMatch(/SET NOT NULL/);
    expect(ms[1]!.destructive.join()).toMatch(/tightens a column/);
    expect(ms[1]!.version).toBe(3);
  });
  it('removing a column, a table or an enum value is destructive and flagged', () => {
    const n = clone();
    n.entities[1]!.fields.splice(4, 1); // assigneeEmail
    n.entities[1]!.fields[1]!.enumValues = ['Todo', 'Done'];
    n.entities.shift(); // Project (referenced by Task.project would dangle: also drop that field)
    n.entities[0]!.fields.splice(3, 1);
    const ms = diffSpecs(SAMPLE_SPEC, n, 2);
    const c = ms.find((m) => m.phase === 'contract')!;
    expect(c.destructive.length).toBeGreaterThanOrEqual(3);
    const all = c.destructive.join('\n');
    expect(all).toMatch(/DROP COLUMN/);
    expect(all).toMatch(/DROP TABLE "projects"/);
    expect(all).toMatch(/DELETE FROM "tasks"/);
    expect(c.down).toMatch(/DATA REMOVED BY THE UP SCRIPT IS NOT RESTORED/);
  });
  it('a rename is never guessed: it is a drop plus an add and therefore destructive', () => {
    const n = clone();
    n.entities[1]!.fields[0]!.name = 'heading';
    n.entities[1]!.searchable = ['heading'];
    n.entities[1]!.sortable = ['heading'];
    const c = diffSpecs(SAMPLE_SPEC, n, 2).find((m) => m.phase === 'contract')!;
    expect(c.destructive.join()).toMatch(/DROP COLUMN "title"/);
  });
  it('no change => no migrations', () => {
    expect(diffSpecs(SAMPLE_SPEC, clone(), 2)).toEqual([]);
  });
});
describe('destructive statement detector', () => {
  it.each([
    ['DROP TABLE users;', true],
    ['TRUNCATE accounts;', true],
    ['ALTER TABLE a DROP COLUMN b;', true],
    ['DELETE FROM a WHERE id = 1;', true],
    ['UPDATE a SET b = 1;', true],
    ['ALTER TABLE a ALTER COLUMN b TYPE text;', true],
    ['ALTER TABLE a ALTER COLUMN b SET NOT NULL;', true],
    ['  drop   column  x ; -- sneaky\n alter table a drop column c;', true],
    ['CREATE TABLE a (id int);', false],
    ['ALTER TABLE a ADD COLUMN b text;', false],
    ['UPDATE a SET b = 1 WHERE c = 2;', false],
    ['CREATE INDEX i ON a (b);', false],
  ])('%s -> destructive=%s', (sql, expected) => {
    expect(detectDestructive(sql).length > 0).toBe(expected);
  });
});
