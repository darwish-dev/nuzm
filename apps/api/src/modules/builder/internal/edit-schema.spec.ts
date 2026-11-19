import { describe, expect, it } from 'vitest';
import { getTemplate, validateSchema } from '@nuzm/domain';
import { EDIT_OP_KINDS, EDIT_SCHEMA, checkEditOps } from './edit.handler';

const ok = (v: unknown) => validateSchema(EDIT_SCHEMA, v).length === 0;
const summary = { ar: 'م', en: 'S' };

describe('edit agent schema: the model is told the exact shape of every operation', () => {
  it('accepts well-formed operations of the allowed kinds', () => {
    expect(
      ok({
        summary,
        ops: [
          {
            op: 'setText',
            target: 'section',
            pageId: 'home',
            sectionId: 'hero1',
            prop: 'heading',
            locale: 'en',
            value: 'Hi',
          },
          { op: 'deleteComponent', pageId: 'home', sectionId: 'text1' },
          { op: 'moveComponent', pageId: 'home', sectionId: 'hero1', index: 1 },
        ],
      }),
    ).toBe(true);
    expect(ok({ summary, ops: [] })).toBe(true);
  });
  it('rejects what a model improvises: wrong field layout, unknown kinds, extra fields, bad ids', () => {
    // an invented layout (the failure of a real run: "op 1: is malformed")
    expect(ok({ summary, ops: [{ type: 'setText', target: 'hero', text: 'Hi' }] })).toBe(false);
    expect(ok({ summary, ops: [{ op: 'rewriteEverything' }] })).toBe(false);
    expect(
      ok({
        summary,
        ops: [{ op: 'deleteComponent', pageId: 'home', sectionId: 'x', force: true }],
      }),
    ).toBe(false);
    expect(
      ok({ summary, ops: [{ op: 'deleteComponent', pageId: 'Home Page', sectionId: 'x' }] }),
    ).toBe(false);
    expect(
      ok({
        summary,
        ops: Array.from({ length: 51 }, () => ({
          op: 'deleteComponent',
          pageId: 'home',
          sectionId: 'x',
        })),
      }),
    ).toBe(false);
  });
  it('does not offer operations outside the allowed list', () => {
    expect(EDIT_OP_KINDS).not.toContain('deletePage');
    expect(ok({ summary, ops: [{ op: 'deletePage', pageId: 'home' }] })).toBe(false);
  });
  it('the schema JSON that goes into the prompt names every allowed operation and its fields', () => {
    const text = JSON.stringify(EDIT_SCHEMA);
    for (const k of EDIT_OP_KINDS) expect(text).toContain(`"${k}"`);
    expect(text).toContain('sectionId');
    expect(text.length).toBeLessThan(12_000); // a prompt, not a document
  });
});

describe('edit agent: ops are checked against the real site before they are proposed', () => {
  const model = getTemplate('services')!.build({
    name: { ar: 'نظم', en: 'Nuzm' },
    locales: ['ar', 'en'],
  });
  const home = model.pages.find((p) => p.slug === 'home')!;
  const hero = home.sections[0]!;
  it('passes a valid change and reports the reason for an invalid one', () => {
    const good = {
      summary,
      ops: [
        {
          op: 'setText',
          target: 'section',
          pageId: home.id,
          sectionId: hero.id,
          prop: 'heading',
          locale: 'en',
          value: 'A better heading',
        },
      ],
    };
    expect(checkEditOps(model, good)).toEqual([]);
    // a section with no props at all passes the op SHAPE but is not a valid section: the model must be told, not the user
    const bad = {
      summary,
      ops: [{ op: 'insertComponent', pageId: home.id, index: 1, section: { type: 'hero' } }],
    };
    const errs = checkEditOps(model, bad);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/op|site model/);
  });
  it('reports an unknown section id as a message, never a crash', () => {
    const errs = checkEditOps(model, {
      summary,
      ops: [{ op: 'deleteComponent', pageId: home.id, sectionId: 'nope' }],
    });
    expect(errs.join(' ')).toContain('unknown component');
  });
});
