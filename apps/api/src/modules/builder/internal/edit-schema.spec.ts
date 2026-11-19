import { describe, expect, it } from 'vitest';
import { validateSchema } from '@nuzm/domain';
import { EDIT_OP_KINDS, EDIT_SCHEMA } from './edit.handler';

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
