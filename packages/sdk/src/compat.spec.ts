/* eslint-disable @typescript-eslint/no-explicit-any -- the fixtures mutate a loosely typed OpenAPI document on purpose */
import { describe, expect, it } from 'vitest';
import { compat, type Doc } from './compat';

const base = (): Doc => ({
  paths: {
    '/a': {
      get: {
        operationId: 'getA',
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Out' } } },
          },
          '404': {},
        },
      },
      post: {
        operationId: 'postA',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/In' } } },
        },
        responses: { '200': {} },
      },
    },
  },
  components: {
    schemas: {
      Out: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['x', 'y'] } },
      },
      In: {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', enum: ['one', 'two'] }, note: { type: 'string' } },
      },
    },
  },
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const levels = (h: Doc) => compat(base(), h).map((f) => `${f.level}: ${f.where} ${f.what}`);

describe('OpenAPI backward-compatibility check', () => {
  it('an identical contract has no findings', () => {
    expect(levels(base())).toEqual([]);
  });
  it('additive changes are fine: a new operation, a new optional field, a new REQUEST enum value, a new required RESPONSE field', () => {
    const h = clone(base());
    h.paths!['/b'] = { get: { operationId: 'getB', responses: { '200': {} } } };
    (h.components!.schemas!.Out as any).properties.extra = { type: 'string' };
    (h.components!.schemas!.Out as any).required.push('extra');
    (h.components!.schemas!.In as any).properties.action.enum.push('three');
    (h.components!.schemas!.In as any).properties.more = { type: 'string' };
    expect(levels(h)).toEqual([]);
  });
  it('a value added to a RESPONSE enum is a warning, not a break', () => {
    const h = clone(base());
    (h.components!.schemas!.Out as any).properties.kind.enum.push('z');
    expect(levels(h)).toEqual([
      expect.stringMatching(/^WARNING: Out\.kind enum value\(s\) added to a RESPONSE: z/),
    ]);
  });
  it('removals and tightenings are breaking', () => {
    const h = clone(base());
    delete h.paths!['/a']!.post;
    (h.paths!['/a']!.get as any).operationId = 'renamed';
    delete (h.paths!['/a']!.get as any).responses['404'];
    delete (h.components!.schemas!.Out as any).properties.kind;
    (h.components!.schemas!.Out as any).required = [];
    (h.components!.schemas!.In as any).required.push('note');
    (h.components!.schemas!.In as any).properties.action.enum = ['one'];
    (h.components!.schemas!.In as any).properties.note = { type: 'integer' };
    const l = levels(h);
    for (const w of [
      'POST /a operation removed',
      'operationId changed',
      'response 404 removed',
      'Out.kind property removed',
      'Out.id was required in a response, now optional',
      'In.note newly required in a request schema',
      'In.action enum value(s) removed: two',
      'In.note type changed',
    ])
      expect(
        l.some((x) => x.startsWith('BREAKING') && x.includes(w)),
        w,
      ).toBe(true);
  });
  it('a new required parameter or a removed schema is breaking', () => {
    const h = clone(base());
    (h.paths!['/a']!.get as any).parameters = [{ name: 'q', in: 'query', required: true }];
    delete h.components!.schemas!.In;
    const l = levels(h);
    expect(l.some((x) => x.includes('required parameter query:q added'))).toBe(true);
    expect(l.some((x) => x.includes('In schema removed'))).toBe(true);
  });
});
