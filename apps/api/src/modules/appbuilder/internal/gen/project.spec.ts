import { describe, expect, it } from 'vitest';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { generateOpenApi } from './openapi';
import { generateProject, runtimeFiles } from './project';

describe('project generation', () => {
  it('is deterministic: the same spec gives the same bytes', () => {
    const a = generateProject(SAMPLE_SPEC);
    const b = generateProject(SAMPLE_SPEC);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
    expect(a.specHash).toBe(b.specHash);
  });
  it('contains the runtime, the spec-derived files, tests and a down script for every migration', () => {
    const p = generateProject(SAMPLE_SPEC);
    for (const f of [
      'src/engine.ts',
      'src/meta.ts',
      'public/app.js',
      'public/meta.json',
      'openapi.json',
      'db/migrations/0001_init.sql',
      'db/migrations/0001_init.down.sql',
      'tests/rbac.test.ts',
      'tests/scope.test.ts',
      'package.json',
      'tsconfig.json',
      'nuzm.app.json',
      'README.md',
      '.env.example',
    ])
      expect(p.files.has(f), f).toBe(true);
    expect(Object.keys(runtimeFiles()).length).toBeGreaterThan(15);
  });
  it('contains no secret-looking value and no absolute path of this machine', () => {
    const p = generateProject(SAMPLE_SPEC);
    for (const [path, c] of p.files) {
      expect(c, path).not.toMatch(
        /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|\/Users\/|\/home\/[a-z]/,
      );
    }
  });
  it('the OpenAPI document has an operationId, tags, a description and an error response for every operation', () => {
    const o = generateOpenApi(SAMPLE_SPEC) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            tags?: string[];
            description?: string;
            responses: Record<string, unknown>;
          }
        >
      >;
    };
    const ids = new Set<string>();
    for (const [path, ops] of Object.entries(o.paths))
      for (const [m, op] of Object.entries(ops)) {
        expect(op.operationId, `${m} ${path}`).toBeTruthy();
        expect(ids.has(op.operationId!), 'duplicate ' + op.operationId).toBe(false);
        ids.add(op.operationId!);
        expect(op.tags?.length).toBeGreaterThan(0);
        expect(op.description).toBeTruthy();
        expect(Object.keys(op.responses).some((c) => /^[45]/.test(c)) || path === '/health').toBe(
          true,
        );
      }
  });
});
