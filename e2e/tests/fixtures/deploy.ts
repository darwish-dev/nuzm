import { expect, type Page } from '@playwright/test';
import { sql } from './templates';

/**
 * Deployment fixtures (Session 06). EVERYTHING here is SIMULATED and local:
 *  - the hosting node, plan and site are rows written with SQL into the throw-away e2e database (no hosting provider, no credential, no paid resource: HG-05/HG-06);
 *  - the site publisher in the e2e API is the in-memory fake node (`AI_LOCAL_REFERENCE=true`): its URLs end in `.invalid`, nothing is reachable from outside;
 *  - the sandbox runtime of the e2e API (`MockSandboxRuntime`) starts no process, so the generated project is made deployable WITHOUT a build step (see `makeDeployable`).
 * A passing run proves the console + API + pipeline plumbing. It is NOT evidence about a real hosting node.
 */

/** `hosting.enabled` on (the deploy form lists the organization's hosting sites only while hosting is on). */
export async function enableHosting() {
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'hosting.enabled', NULL, 'true') ON CONFLICT DO NOTHING`,
  );
  await sql(
    `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'hosting.enabled' AND org_id IS NULL`,
  );
}

/** A seeded node, plan and ACTIVE site of the organization; returns the site id. `domain` is optional (without one the simulated URL is `<name>.sites.nuzm.invalid`). */
export async function seedHostingSite(
  orgId: string,
  userId: string,
  label: string,
  opts: { domain?: string | null } = {},
): Promise<string> {
  const node = crypto.randomUUID();
  const plan = crypto.randomUUID();
  const site = crypto.randomUUID();
  await sql(
    `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,$2,$3,'r','sa-central','active','healthy','["php:8.3"]')`,
    [node, `e2e-d-${label}-${node.slice(0, 6)}`, `e2e-di-${node}`],
  );
  await sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, price_minor, placeholder) VALUES ($1,$2,'خطة اختبار','Test plan','active','{"diskMb":100,"inodes":5000,"bandwidthGb":10,"dbCount":1,"sitesCount":1}','["php"]','{"cpu_millicores":100,"memory_mb":128,"disk_mb":500}',10000,true)`,
    [plan, `e2e-d-${label}-${plan.slice(0, 6)}`],
  );
  await sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, node_id, created_by, domain_primary) VALUES ($1,$2,$3,$4,$5,$6,'php:8.3','active','sa-central',$7,$8,$9)`,
    [
      site,
      orgId,
      `e2e-dep-${label}`,
      'd'.repeat(64),
      `s-${site.replace(/-/g, '').slice(0, 20)}`,
      plan,
      node,
      userId,
      opts.domain ?? null,
    ],
  );
  return site;
}

/** The lockfile the package mirror would have produced for this manifest (every dependency resolved inside the mirror, with integrity and licence). */
export function mirrorLockfile(pkg: { dependencies?: object; devDependencies?: object }): string {
  const names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(
        names.map((n) => [
          `node_modules/${n}`,
          {
            version: '1.0.0',
            resolved: `https://npm-mirror.nuzm.internal/${n}.tgz`,
            integrity: 'sha512-AAAA',
            license: 'MIT',
          },
        ]),
      ),
    },
  });
}

/**
 * Make the generated web app of `projectId` deployable on the e2e stack, through the product's own safe-diff `changes` API (as the signed-in owner):
 *  1. add the lockfile (the generated project ships none: the supply-chain gate refuses a deployment without one);
 *  2. drop the `install` and `build` commands from `nuzm.app.json`: the e2e sandbox runtime starts no process, so those commands would end with exit 127.
 *     The release is then the generated sources as they are (`public/**` is what the simulated node serves). The build is therefore SIMULATED too.
 */
export async function makeDeployable(page: Page, orgId: string, projectId: string) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'nuzm_csrf')?.value;
  expect(csrf, 'a signed-in session with a csrf cookie').toBeTruthy();
  const headers = { 'x-csrf-token': csrf!, 'x-nuzm-org': orgId };
  const read = async (path: string) => {
    const r = await page.request.get(
      `/v1/builder/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`,
      { headers },
    );
    expect(r.status(), `read ${path}`).toBe(200);
    const j = (await r.json()) as { content?: string };
    return j.content ?? '';
  };
  const project = await page.request.get(`/v1/builder/projects/${projectId}`, { headers });
  expect(project.status()).toBe(200);
  const head = ((await project.json()) as { headVersionId: string }).headVersionId;
  const pkg = JSON.parse(await read('package.json')) as {
    dependencies?: object;
    devDependencies?: object;
  };
  const manifest = JSON.parse(await read('nuzm.app.json')) as {
    commands?: Record<string, unknown>;
  };
  if (manifest.commands) {
    delete manifest.commands.install;
    delete manifest.commands.build;
  }
  const r = await page.request.post(`/v1/builder/projects/${projectId}/changes`, {
    headers: { ...headers, 'idempotency-key': `e2e-deployable-${projectId}` },
    data: {
      baseVersion: head,
      message: 'e2e: lockfile from the package mirror; no sandbox build (simulated)',
      patches: [
        { op: 'add', path: 'package-lock.json', content: mirrorLockfile(pkg) },
        { op: 'modify', path: 'nuzm.app.json', content: JSON.stringify(manifest, null, 2) },
      ],
    },
  });
  expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
}
