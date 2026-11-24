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

/** Flags the deploy screens need (all global, all written with SQL into the throw-away e2e database). */
export async function enableDeployFlags() {
  for (const key of ['ai.enabled', 'app_builder.enabled', 'hosting.enabled']) {
    await sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, 'true') ON CONFLICT DO NOTHING`,
      [key],
    );
    await sql(
      `UPDATE platform.feature_flags SET value = 'true' WHERE key = $1 AND org_id IS NULL`,
      [key],
    );
  }
}

/** The headers of a signed-in console session calling the API through the console's own origin (cookie session + csrf + the organization). */
export async function sessionHeaders(page: Page, orgId: string, idempotencyKey?: string) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'nuzm_csrf')?.value;
  expect(csrf, 'a signed-in session with a csrf cookie').toBeTruthy();
  return {
    'x-csrf-token': csrf!,
    'x-nuzm-org': orgId,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

/**
 * A web-app project that is deployable on the e2e stack WITHOUT an AI build: created through the product's own API (`POST /v1/builder/projects`, then the safe-diff
 * `changes` API). The files are a static app (`public/index.html`), a manifest, and the lockfile the package mirror would have produced (the supply-chain gate refuses a
 * deployment without one). `failingBuild` adds a `build` command the e2e sandbox runtime (`MockSandboxRuntime`) does not know: the build then ends with exit 127, which the
 * pipeline must report as `build_failed`. Everything is SIMULATED: no process runs, no node is reached.
 */
export async function createDeployableWebapp(
  page: Page,
  orgId: string,
  name: string,
  opts: { failingBuild?: boolean } = {},
): Promise<string> {
  const created = await page.request.post(`/v1/builder/projects`, {
    headers: await sessionHeaders(page, orgId, `e2e-webapp-${name}`),
    data: { type: 'webapp', name },
  });
  expect(created.status(), (await created.text()).slice(0, 300)).toBeLessThan(300);
  const projectId = ((await created.json()) as { id: string }).id;
  const pkg: { name: string; version: string; private: boolean; dependencies?: object } = {
    name: `e2e-${name}`.toLowerCase(),
    version: '1.0.0',
    private: true,
  };
  const manifest = {
    name,
    deploy: { healthPath: '/index.html' },
    ...(opts.failingBuild ? { commands: { build: ['not-a-registered-build-tool'] } } : {}),
  };
  const r = await page.request.post(`/v1/builder/projects/${projectId}/changes`, {
    headers: await sessionHeaders(page, orgId, `e2e-webapp-files-${name}`),
    data: {
      baseVersion: null,
      message: 'e2e: a static app and the mirror lockfile (simulated, no build)',
      patches: [
        { op: 'add', path: 'package.json', content: JSON.stringify(pkg, null, 2) },
        { op: 'add', path: 'package-lock.json', content: mirrorLockfile(pkg) },
        { op: 'add', path: 'nuzm.app.json', content: JSON.stringify(manifest, null, 2) },
        {
          op: 'add',
          path: 'public/index.html',
          content: '<!doctype html><title>e2e</title><h1>e2e simulated app</h1>\n',
        },
      ],
    },
  });
  expect(r.status(), (await r.text()).slice(0, 400)).toBe(200);
  return projectId;
}

/** A website project the way the API creates it (`POST /v1/builder/projects`, no AI run); returns its id and head version. */
export async function createWebsite(page: Page, orgId: string, name: string) {
  const created = await page.request.post(`/v1/builder/projects`, {
    headers: await sessionHeaders(page, orgId, `e2e-site-${name}`),
    data: { type: 'website', name, locale: ['en'] },
  });
  expect(created.status(), (await created.text()).slice(0, 300)).toBeLessThan(300);
  const p = (await created.json()) as { id: string; headVersionId: string | null };
  expect(p.headVersionId, 'the new website project has a first version').toBeTruthy();
  return { projectId: p.id, versionId: p.headVersionId! };
}

/**
 * A website deployment that is QUEUED and stays queued: the row and its `deploy.run` operation are written with SQL, exactly as `DeployService.create` writes them, but
 * the in-process kicker (which would start the job at once and finish it in milliseconds) is never called, and the e2e API runs no scheduler
 * (`DEPLOY_SCHEDULER_INTERVAL_SECONDS` unset). The cancel button is then deterministic: the job cannot have finished before the click. The cancel itself goes through the
 * real route (`POST /v1/deployments/:id/cancel`), which cancels the queued operation.
 */
export async function seedQueuedWebsiteDeployment(o: {
  orgId: string;
  userId: string;
  projectId: string;
  versionId: string;
  siteId: string;
  environment?: 'staging' | 'production';
}): Promise<string> {
  const id = crypto.randomUUID();
  const op = crypto.randomUUID();
  await sql(
    `INSERT INTO deploy.deployments (id, org_id, project_id, version_id, target_ref, environment, operation_id, idempotency_key, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sa-central',$9)`,
    [
      id,
      o.orgId,
      o.projectId,
      o.versionId,
      o.siteId,
      o.environment ?? 'staging',
      op,
      `e2e-q-${id}`,
      o.userId,
    ],
  );
  await sql(
    `INSERT INTO platform.operations (id, org_id, kind, input, resource_kind, resource_id, created_by, max_attempts) VALUES ($1,$2,'deploy.run',$3,'deployment',$4,$5,3)`,
    [op, o.orgId, JSON.stringify({ deploymentId: id }), id, o.userId],
  );
  return id;
}
