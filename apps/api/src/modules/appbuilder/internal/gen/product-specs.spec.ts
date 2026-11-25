import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { validateAppSpec } from '../spec/app-spec';
import { generateProject, runtimeFiles } from './project';
import { productApp, WEB_PRODUCTS, type ProductBrief } from './product-specs';
import { workspaceSeed } from './probe-runner';
import { platformFileHashes, runStaticGates } from './static-gates';

const brief: ProductBrief = { name: 'Synthetic Co', selfRegistration: true };
const apiDir = join(__dirname, '../../../../..');
const repoRoot = join(apiDir, '../..');
const tsc = [join(repoRoot, 'node_modules/.bin/tsc')].find((p) => existsSync(p));
const cleanup: string[] = [];
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('product generators: CRM, ERP, SaaS, e-commerce', () => {
  for (const product of WEB_PRODUCTS) {
    describe(product, () => {
      const app = productApp(product, brief);
      it('produces a spec the builder accepts, deterministically', () => {
        expect(validateAppSpec(app.spec)).toEqual({ ok: true, issues: [] });
        expect(JSON.stringify(productApp(product, brief))).toBe(JSON.stringify(app));
        expect(app.spec.slug).toMatch(/^[a-z][a-z0-9-]{1,40}$/);
        expect(app.notIncluded.length).toBeGreaterThan(0);
      });
      it('follows the platform rules: no float money, personal data classified, one administrator role, least privilege', () => {
        for (const e of app.spec.entities)
          for (const fld of e.fields) {
            expect(fld.type, `${e.name}.${fld.name}`).not.toBe('decimal'); // money is an integer in minor units next to a currency
            if (
              /email|phone/.test(fld.type) ||
              (/^(name|firstName|lastName)$/.test(fld.name) &&
                /customer|contact|member/i.test(e.name))
            )
              expect(fld.pii, `${e.name}.${fld.name}`).toBe(true);
            if (/Minor$/.test(fld.name)) expect(fld.type).toBe('integer');
          }
        // an entity with money carries a currency, or belongs to an order/record that does (a line inherits its parent's currency)
        const hasCurrency = (e: (typeof app.spec.entities)[number]): boolean =>
          e.fields.some((x) => x.name === 'currency') ||
          e.fields.some(
            (x) =>
              x.type === 'reference' &&
              hasCurrency(app.spec.entities.find((t) => t.name === x.references)!),
          );
        for (const e of app.spec.entities.filter((x) =>
          x.fields.some((y) => /Minor$/.test(y.name)),
        ))
          expect(hasCurrency(e), e.name + ' has money without a currency').toBe(true);
        expect(app.spec.roles.filter((r) => r.admin).map((r) => r.name)).toEqual(['admin']);
        // a read-only role can only read and export
        for (const r of app.spec.roles.filter((x) => x.name === 'read_only'))
          for (const a of Object.values(r.permissions))
            expect(a.every((x) => x === 'read' || x === 'export')).toBe(true);
      });
      it('generates a project that passes the static gates and whose workspace seed passes the gateway secret screen', () => {
        const p = generateProject(app.spec, app.options);
        const g = runStaticGates(p.files, { platformFiles: platformFileHashes(runtimeFiles()) });
        expect(g.findings.filter((x) => x.severity === 'blocker')).toEqual([]);
        const seed = [...workspaceSeed(p.files)].map(([path, content]) => ({ path, content }));
        expect(eg.checkWorkspaceFiles(seed).refused).toEqual([]);
        expect(p.migrations).toHaveLength(1);
        expect(p.files.has('tests/rbac.test.ts')).toBe(true);
        expect(p.files.has('probe/run.ts')).toBe(true);
      });
      it.skipIf(!tsc)(
        'type-checks (static; nothing is executed)',
        () => {
          const p = generateProject(app.spec, app.options);
          const dir = mkdtempSync(join(tmpdir(), 'p3s05-prod-'));
          cleanup.push(dir);
          for (const [path, content] of p.files) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), content);
          }
          mkdirSync(join(dir, 'node_modules/@types'), { recursive: true });
          for (const [name, from] of [
            ['pg', join(apiDir, 'node_modules/pg')],
            ['@types/pg', join(apiDir, 'node_modules/@types/pg')],
            ['@types/node', join(repoRoot, 'node_modules/@types/node')],
          ] as const)
            symlinkSync(from, join(dir, 'node_modules', name));
          const r = spawnSync(tsc as string, ['--noEmit', '-p', 'tsconfig.json'], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 170_000,
          });
          expect((r.stdout ?? '') + (r.stderr ?? '')).toBe('');
        },
        180_000,
      );
    });
  }
  it('SaaS is multi-tenant with an organisation sign-up; the others are single-tenant and off by default', () => {
    expect(productApp('saas', { name: 'S' }).options).toEqual({
      tenancy: 'multi',
      signupRole: 'auto',
    });
    for (const p of ['crm', 'erp', 'ecommerce'] as const) {
      expect(productApp(p, { name: 'X1' }).options).toEqual({});
      expect(productApp(p, { name: 'X1', selfRegistration: true }).options).toEqual({
        signupRole: 'auto',
      });
    }
  });
  it('derives a valid slug from any display name and carries the brief', () => {
    expect(productApp('erp', { name: 'شركة النور ERP' }).spec.slug).toMatch(
      /^[a-z][a-z0-9-]{1,40}$/,
    );
    const a = productApp('ecommerce', {
      name: 'My Shop',
      slug: 'my-shop',
      defaultLocale: 'en',
      currencies: ['SAR'],
      dataRegion: 'sa-central',
    });
    expect(a.spec).toMatchObject({ slug: 'my-shop', defaultLocale: 'en' });
    expect(JSON.stringify(a.spec)).not.toContain('USD');
  });
});
