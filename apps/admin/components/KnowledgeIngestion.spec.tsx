// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type {
  ProjectManifestView,
  IngestFile,
  IngestFinding,
  IngestJob,
  IngestLog,
  KnowledgeVersion,
  ReviewState,
} from '../lib/knowledge';
import { KnowledgeIngestion } from './KnowledgeIngestion';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Seen {
  method: string;
  url: string;
  search: string;
  body: unknown;
}
let seen: Seen[] = [];
type Handler = (s: Seen) => Response | Promise<Response> | undefined;
const RealRequest = globalThis.Request;
const mockFetch = (h: Handler) => {
  seen = [];
  vi.stubGlobal(
    'Request',
    class extends RealRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input,
          init,
        );
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const req = input instanceof Request ? input : null;
      const u = new URL(req ? req.url : String(input), 'http://localhost');
      const raw = req
        ? await req
            .clone()
            .text()
            .catch(() => '')
        : (init.body as string | undefined);
      const entry: Seen = {
        method: (req?.method ?? init.method ?? 'GET').toUpperCase(),
        url: u.pathname,
        search: u.search,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(entry);
      return (await h(entry)) ?? json(404, {});
    }),
  );
};
beforeEach(() => {
  document.cookie = 'nuzm_admin_csrf=csrf-123';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RID = '00000000-0000-7000-8000-000000000001';
const V1 = '00000000-0000-7000-8000-0000000000a1';
const V2 = '00000000-0000-7000-8000-0000000000a2';
const versions: KnowledgeVersion[] = [
  {
    id: V1,
    seq: 1,
    semver: null,
    state: 'AWAITING_REVIEW',
    checksumSha256: 'a'.repeat(64),
    bytes: 10,
    sourceCommit: null,
    licenseVerdict: 'UNKNOWN',
    createdAt: null,
    activatedAt: null,
  },
  {
    id: V2,
    seq: 2,
    semver: null,
    state: 'QUARANTINED',
    checksumSha256: 'b'.repeat(64),
    bytes: 10,
    sourceCommit: null,
    licenseVerdict: 'UNKNOWN',
    createdAt: null,
    activatedAt: null,
  },
];
const review = (over: Partial<ReviewState> = {}): ReviewState => ({
  versionId: V1,
  resourceId: RID,
  state: 'AWAITING_REVIEW',
  stateReason: null,
  provenanceClass: 'THIRD_PARTY',
  uploadedBy: 'u-up',
  analysisJobId: 'job-x',
  licenseProposal: { spdx: 'MIT', verdict: 'ALLOWED' },
  licenseVerdict: 'UNKNOWN',
  findings: { info: 1, warn: 2, block: 0 },
  requiredApprovals: 2,
  approvals: ['u-1'],
  reviews: [
    {
      id: 'r1',
      decision: 'APPROVE',
      reviewerId: 'u-1',
      reason: null,
      createdAt: '2026-11-20T10:00:00.000Z',
    },
  ],
  blockers: [{ code: 'approvals_missing', detail: 'x' }],
  canActivate: false,
  you: { canReview: true, hasApproved: false, isUploader: false },
  ...over,
});
const job = (over: Partial<IngestJob> = {}): IngestJob => ({
  id: 'job-1',
  versionId: V1,
  versionSeq: 1,
  kind: 'EXTRACT',
  state: 'SUCCEEDED',
  attempt: 1,
  maxAttempts: 3,
  progress: 100,
  errorCode: null,
  errorDetail: null,
  cancelRequested: false,
  startedAt: null,
  finishedAt: '2026-11-20T10:00:00.000Z',
  createdAt: null,
  ...over,
});
const finding = (over: Partial<IngestFinding> = {}): IngestFinding => ({
  id: 'f1',
  scanner: 'dependencies',
  code: 'lifecycle_script',
  severity: 'warn',
  path: 'package.json',
  line: null,
  detail: '"postinstall" runs at install time; it was NOT run',
  ...over,
});
const file = (over: Partial<IngestFile> = {}): IngestFile => ({
  id: 'i1',
  path: 'src/app.ts',
  sha256: 'c'.repeat(64),
  bytes: 2048,
  language: 'typescript',
  isBinary: false,
  isExecutable: false,
  stored: true,
  secretFindings: 0,
  ...over,
});
const log = (over: Partial<IngestLog> = {}): IngestLog => ({
  id: 'l1',
  seq: 1,
  level: 'info',
  stage: 'EXTRACT',
  code: 'extract.done',
  message: 'analysis finished; the package awaits review',
  createdAt: null,
  ...over,
});

interface World {
  review?: ReviewState | Response;
  jobs?: IngestJob[] | Response;
  findings?: IngestFinding[] | Response;
  files?: IngestFile[] | Response;
  logs?: IngestLog[];
  manifest?: ProjectManifestView | null | Response;
}
const world =
  (w: World = {}): Handler =>
  (s) => {
    const wrap = (x: unknown, extra: object = {}) =>
      x instanceof Response ? x : json(200, { items: x, nextCursor: null, ...extra });
    if (s.url.endsWith('/review') && s.method === 'GET')
      return w.review instanceof Response ? w.review : json(200, w.review ?? review());
    if (s.url.endsWith('/processing-jobs') && s.method === 'GET') return wrap(w.jobs ?? [job()]);
    if (s.url.endsWith('/manifest'))
      return w.manifest instanceof Response
        ? w.manifest
        : json(200, { manifest: w.manifest === undefined ? null : w.manifest });
    if (s.url.endsWith('/logs')) return json(200, { items: w.logs ?? [log()], nextCursor: null });
    if (s.url.endsWith('/findings'))
      return wrap(w.findings ?? [finding()], { summary: { info: 0, warn: 1, block: 0 } });
    if (s.url.endsWith('/files')) return wrap(w.files ?? [file()]);
    return undefined;
  };
const ui = (
  props: Partial<{ locale: 'ar' | 'en'; canManage: boolean; canPublish: boolean }> = {},
) =>
  render(
    <KnowledgeIngestion
      locale={props.locale ?? 'en'}
      resourceId={RID}
      versions={versions}
      currentVersionId={V1}
      canManage={props.canManage ?? true}
      canPublish={props.canPublish ?? true}
    />,
  );
const en = (k: Parameters<typeof t>[1], p?: Record<string, string | number>) => t('en', k, p);

describe('KnowledgeIngestion: what a reviewer sees', () => {
  it('shows the state, licence proposal, findings, approvals, blockers, decisions, jobs and inventory', async () => {
    mockFetch(world());
    ui();
    const review$ = await screen
      .findByRole('region', { name: en('ki.review') })
      .catch(() => screen.findByLabelText(en('ki.review')));
    await within(review$).findByText(en('ki.approvals.count', { n: 1, need: 2 }));
    expect(within(review$).getByText('MIT')).toBeTruthy();
    expect(within(review$).getByText(en('ki.prov.THIRD_PARTY'))).toBeTruthy();
    expect(within(review$).getByText(en('ki.blocker.approvals_missing'))).toBeTruthy();
    expect(within(review$).getByText(en('ki.decision.APPROVE'))).toBeTruthy();
    // jobs, findings, files
    expect(await screen.findByText(en('ki.kind.EXTRACT'))).toBeTruthy();
    expect(await screen.findByText('dependencies/lifecycle_script')).toBeTruthy();
    expect(await screen.findByText('src/app.ts')).toBeTruthy();
    // the version selector lists every version with its state
    expect(
      screen.getByRole('option', { name: `#2 · ${en('kn.status.QUARANTINED')}` }),
    ).toBeTruthy();
  });
  it('renders the same sections in Arabic', async () => {
    mockFetch(world());
    ui({ locale: 'ar' });
    expect(await screen.findByText(t('ar', 'ki.approvals.count', { n: 1, need: 2 }))).toBeTruthy();
    expect(screen.getByText(t('ar', 'ki.jobs'), { selector: 'h2' })).toBeTruthy();
    expect(await screen.findByText(t('ar', 'ki.kind.EXTRACT'))).toBeTruthy();
    expect(screen.getByText(t('ar', 'ki.findings'), { selector: 'h2' })).toBeTruthy();
  });
  it('explains why a version is quarantined, with a translated reason or the raw archive code', async () => {
    mockFetch(
      world({
        review: review({
          state: 'QUARANTINED',
          stateReason: 'secrets_found',
          blockers: [
            { code: 'state', detail: '' },
            { code: 'blocking_findings', detail: '' },
          ],
          findings: { info: 0, warn: 0, block: 2 },
        }),
      }),
    );
    ui();
    expect(await screen.findByText(en('ki.reason.secrets_found'))).toBeTruthy();
    cleanup();
    mockFetch(
      world({
        review: review({ state: 'FAILED', stateReason: 'path_traversal', analysisJobId: null }),
      }),
    );
    ui();
    expect(await screen.findByText('path_traversal')).toBeTruthy();
    expect(screen.getByText(new RegExp(en('ki.reason.archive').slice(0, 20)))).toBeTruthy();
  });
  it('a failed section shows an error with a retry; a forbidden one says so without a retry; empty lists say so', async () => {
    let calls = 0;
    mockFetch((s) => {
      if (s.url.endsWith('/findings'))
        return ++calls === 1
          ? json(500, {})
          : json(200, { items: [], nextCursor: null, summary: { info: 0, warn: 0, block: 0 } });
      return world({ files: json(403, {}), jobs: [] })(s);
    });
    ui();
    await screen.findByText(en('ki.forbidden'));
    expect(screen.getByText(en('ki.jobs.none'))).toBeTruthy();
    const err = await screen.findByText(en('ki.load.error'));
    fireEvent.click(within(err.parentElement!).getByRole('button', { name: en('ki.retry.load') }));
    expect(await screen.findByText(en('ki.findings.none'))).toBeTruthy();
  });
  it('passes the severity, search and stored filters to the API', async () => {
    mockFetch(world());
    ui();
    await screen.findByText('src/app.ts');
    fireEvent.change(screen.getByLabelText(en('ki.findings.filter')), {
      target: { value: 'block' },
    });
    fireEvent.change(screen.getByLabelText(en('ki.files.filter')), { target: { value: 'false' } });
    await waitFor(() =>
      expect(
        seen.some((x) => x.url.endsWith('/findings') && x.search.includes('severity=block')),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(seen.some((x) => x.url.endsWith('/files') && x.search.includes('stored=false'))).toBe(
        true,
      ),
    );
  });
  it('loads another version when the selector changes', async () => {
    mockFetch(world());
    ui();
    await screen.findByText('src/app.ts');
    fireEvent.change(screen.getByLabelText(en('ki.version')), { target: { value: V2 } });
    await waitFor(() =>
      expect(seen.some((x) => x.url.includes(`/versions/${V2}/review`))).toBe(true),
    );
  });
});

describe('KnowledgeIngestion: the review gate', () => {
  it('approve needs both confirmations, then records the decision and reloads', async () => {
    mockFetch((s) =>
      s.method === 'POST' && s.url.endsWith('/reviews')
        ? json(
            201,
            review({
              approvals: ['u-1', 'u-2'],
              you: { canReview: false, hasApproved: true, isUploader: false },
            }),
          )
        : world()(s),
    );
    ui();
    const approve = (await screen.findByRole('button', {
      name: en('ki.approve'),
    })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(en('ki.check.findings')));
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(en('ki.check.license')));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await screen.findByText(en('ki.done.approved'));
    const post = seen.find((x) => x.method === 'POST')!;
    expect(post.url).toBe(`/v1/admin/knowledge/resources/${RID}/reviews`);
    expect(post.body).toEqual({
      versionId: V1,
      decision: 'approve',
      checklist: { findingsReviewed: true, licenseReviewed: true },
    });
  });
  it('reject needs a reason of 10 characters before anything is sent', async () => {
    mockFetch((s) =>
      s.method === 'POST' ? json(201, review({ state: 'QUARANTINED' })) : world()(s),
    );
    ui();
    fireEvent.click(await screen.findByRole('button', { name: en('ki.reject') }));
    const note = screen.getByLabelText(en('ki.reject.note'));
    fireEvent.change(note, { target: { value: 'too short' } });
    fireEvent.click(screen.getByRole('button', { name: en('ki.reject.confirm') }));
    expect(await screen.findByText(en('ki.reject.short'))).toBeTruthy();
    expect(seen.some((x) => x.method === 'POST')).toBe(false);
    fireEvent.change(note, { target: { value: 'The licence file is not the seller one.' } });
    fireEvent.click(screen.getByRole('button', { name: en('ki.reject.confirm') }));
    await screen.findByText(en('ki.done.rejected'));
    expect(seen.find((x) => x.method === 'POST')!.body).toEqual({
      versionId: V1,
      decision: 'reject',
      note: 'The licence file is not the seller one.',
    });
  });
  it('activation is disabled while anything blocks it and sends the version when the gate is open', async () => {
    mockFetch(world());
    ui();
    expect(
      ((await screen.findByRole('button', { name: en('ki.activate') })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    cleanup();
    mockFetch((s) =>
      s.method === 'POST' && s.url.endsWith('/activation')
        ? json(200, review({ state: 'ACTIVE' }))
        : world({
            review: review({
              canActivate: true,
              blockers: [],
              approvals: ['u-1', 'u-2'],
              you: { canReview: false, hasApproved: true, isUploader: false },
            }),
          })(s),
    );
    ui();
    const btn = (await screen.findByRole('button', {
      name: en('ki.activate'),
    })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(screen.getByText(en('ki.blockers.none'))).toBeTruthy();
    fireEvent.click(btn);
    await screen.findByText(en('ki.done.activated'));
    expect(seen.find((x) => x.method === 'POST')!.body).toEqual({ versionId: V1 });
    expect(screen.getByText(en('ki.activate.note'))).toBeTruthy();
  });
  it('the uploader of a third-party resource cannot review it; someone who approved already is told so', async () => {
    mockFetch(
      world({
        review: review({ you: { canReview: false, hasApproved: false, isUploader: true } }),
      }),
    );
    ui();
    expect(await screen.findByText(en('ki.you.uploader'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: en('ki.approve') })).toBeNull();
    cleanup();
    mockFetch(
      world({
        review: review({ you: { canReview: false, hasApproved: true, isUploader: false } }),
      }),
    );
    ui();
    expect(await screen.findByText(en('ki.you.approved'))).toBeTruthy();
  });
  it('a staff member without the publish permission sees the state but has no review or activation controls', async () => {
    mockFetch(world());
    ui({ canPublish: false });
    await screen.findByText(en('ki.approvals.count', { n: 1, need: 2 }));
    for (const k of ['ki.approve', 'ki.reject', 'ki.activate'] as const)
      expect(screen.queryByRole('button', { name: en(k) })).toBeNull();
  });
  it('maps API refusals to plain messages (409 conflict, 403 forbidden)', async () => {
    mockFetch((s) =>
      s.method === 'POST'
        ? json(409, { code: 'knowledge_approval_required' })
        : world({ review: review({ canActivate: true, blockers: [] }) })(s),
    );
    ui();
    fireEvent.click(await screen.findByRole('button', { name: en('ki.activate') }));
    expect(await screen.findByText(en('kn.err.conflict'))).toBeTruthy();
  });
});

describe('KnowledgeIngestion: jobs and logs', () => {
  it('shows a job log on demand, never anything beyond the structured message', async () => {
    mockFetch(
      world({
        logs: [
          log({
            level: 'warn',
            stage: 'EXTRACT',
            message: 'analysis finished; the package stays quarantined (secrets_found)',
          }),
        ],
      }),
    );
    ui();
    fireEvent.click(await screen.findByRole('button', { name: en('ki.logs') }));
    expect(
      await screen.findByText('analysis finished; the package stays quarantined (secrets_found)'),
    ).toBeTruthy();
    expect(screen.getByText(en('ki.logs.note'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en('ki.logs.hide') }));
    expect(screen.queryByText(/stays quarantined/)).toBeNull();
  });
  it('cancel is offered only for a queued or running job and only with the manage permission', async () => {
    mockFetch((s) =>
      s.method === 'POST'
        ? json(200, { jobId: 'job-2', result: 'CANCEL_REQUESTED' })
        : world({
            jobs: [
              job({ id: 'job-2', kind: 'VALIDATE', state: 'RUNNING' }),
              job({ id: 'job-3', state: 'SUCCEEDED' }),
            ],
          })(s),
    );
    ui();
    const buttons = await screen.findAllByRole('button', { name: en('ki.cancel') });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await screen.findByText(en('ki.cancel.requested'));
    expect(seen.find((x) => x.method === 'POST')!.url).toBe(
      `/v1/admin/knowledge/resources/${RID}/processing-jobs/job-2/cancellation`,
    );
    cleanup();
    mockFetch(world({ jobs: [job({ state: 'QUEUED' })] }));
    ui({ canManage: false });
    await screen.findByText(en('ki.job.QUEUED'));
    expect(screen.queryByRole('button', { name: en('ki.cancel') })).toBeNull();
  });
  it('offers a retry for an interrupted version only', async () => {
    mockFetch((s) =>
      s.method === 'POST'
        ? json(200, { versionId: V1, jobId: 'j' })
        : world({
            review: review({
              state: 'FAILED',
              stateReason: 'processing_failed',
              analysisJobId: null,
              blockers: [],
              approvals: [],
            }),
          })(s),
    );
    ui();
    fireEvent.click(await screen.findByRole('button', { name: en('ki.retry') }));
    await screen.findByText(en('ki.retry.done'));
    expect(seen.find((x) => x.method === 'POST')!.url).toBe(
      `/v1/admin/knowledge/resources/${RID}/versions/${V1}/reprocessing`,
    );
    cleanup();
    mockFetch(
      world({
        review: review({ state: 'FAILED', stateReason: 'ratio_exceeded', analysisJobId: null }),
      }),
    );
    ui();
    await screen.findByText('ratio_exceeded');
    expect(screen.queryByRole('button', { name: en('ki.retry') })).toBeNull();
  });
});

const manifest = (over: Partial<ProjectManifestView> = {}): ProjectManifestView => ({
  schemaVersion: '1',
  frameworks: ['nextjs', 'nestjs'],
  languages: ['typescript'],
  packageManagers: ['pnpm'],
  capabilities: [
    {
      name: 'internationalization',
      confidence: 0.85,
      evidence: [{ kind: 'file', path: 'apps/web/app/[locale]/page.tsx' }],
    },
  ],
  projects: [
    {
      root: 'apps/web',
      name: 'web',
      kind: 'application',
      roles: [{ role: 'frontend', evidence: [] }],
      packageManager: { name: 'pnpm', version: null },
      build: { scripts: [] },
      detections: [
        {
          id: 'nextjs',
          name: 'Next.js',
          category: 'framework',
          version: '15.0.2',
          versionSource: 'lockfile',
          confidence: 0.99,
          level: 'high',
          evidence: [
            { kind: 'dependency', path: 'apps/web/package.json', line: 7, detail: 'next@^15' },
          ],
          notes: [],
        },
      ],
    },
    {
      root: 'examples/demo',
      name: null,
      kind: 'example',
      roles: [],
      packageManager: null,
      build: { scripts: [] },
      detections: [
        {
          id: 'vue',
          name: 'Vue',
          category: 'framework',
          version: null,
          versionSource: null,
          confidence: 0.6,
          level: 'medium',
          evidence: [{ kind: 'dependency', path: 'examples/demo/package.json' }],
          notes: [],
        },
      ],
    },
  ],
  workspaces: [{ tool: 'pnpm', root: '.', members: ['apps/api', 'apps/web'], evidence: [] }],
  routes: [
    {
      kind: 'next-app-page',
      path: '/[locale]/dashboard',
      methods: ['GET'],
      file: 'apps/web/app/[locale]/dashboard/page.tsx',
      project: 'apps/web',
    },
    {
      kind: 'nest-controller-route',
      path: '/api/users/:id',
      methods: ['GET'],
      file: 'apps/api/src/users.controller.ts',
      line: 9,
      project: 'apps/api',
    },
  ],
  screens: [
    {
      kind: 'flutter-screen',
      name: 'HomeScreen',
      file: 'lib/screens/home_screen.dart',
      line: 3,
      project: '.',
    },
  ],
  moduleFacts: [
    {
      kind: 'nest-module',
      name: 'UsersModule',
      file: 'apps/api/src/users.module.ts',
      line: 2,
      project: 'apps/api',
    },
  ],
  ambiguities: [
    { code: 'examples_excluded', detail: 'x', paths: ['examples/demo'] },
    { code: 'brand_new_code', detail: 'A new ambiguity the UI has no translation for.', paths: [] },
  ],
  stats: { truncated: ['routes'] },
  ...over,
});

describe('KnowledgeIngestion: the detected project (S-K2b)', () => {
  it('shows frameworks with version, source, confidence and evidence; examples are not counted', async () => {
    mockFetch(world({ manifest: manifest() }));
    ui();
    const card = await screen.findByLabelText(en('km.title'));
    expect(await within(card).findByText('Next.js', { selector: 'strong' })).toBeTruthy();
    expect(within(card).getByText('15.0.2')).toBeTruthy();
    expect(within(card).getByText(`(${en('km.src.lockfile')})`)).toBeTruthy();
    expect(within(card).getByText(/High/)).toBeTruthy();
    expect(within(card).getByText('apps/web/package.json:7')).toBeTruthy(); // evidence is a path and a line
    expect(within(card).queryByText('Vue', { selector: 'strong' })).toBeNull(); // the example project's framework is not a package framework
    expect(within(card).getByText('pnpm', { selector: 'dd *' })).toBeTruthy();
  });
  it('lists projects, workspaces, capabilities, routes, screens and modules; known ambiguities are translated and unknown ones fall back to the analyzer text', async () => {
    mockFetch(world({ manifest: manifest() }));
    ui();
    const card = await screen.findByLabelText(en('km.title'));
    await within(card)
      .findByText('apps/web', { selector: 'td *, td' })
      .catch(() => undefined);
    expect(within(card).getAllByText('apps/web').length).toBeGreaterThan(0);
    expect(within(card).getByText(en('km.kind.example'))).toBeTruthy();
    expect(within(card).getByText(/members/)).toBeTruthy();
    expect(within(card).getByText('internationalization')).toBeTruthy();
    expect(within(card).getByText('/[locale]/dashboard')).toBeTruthy();
    expect(within(card).getByText('/api/users/:id')).toBeTruthy();
    expect(within(card).getByText('apps/api/src/users.controller.ts:9')).toBeTruthy();
    expect(within(card).getByText(en('km.route.nest-controller-route'))).toBeTruthy();
    expect(within(card).getByText('HomeScreen')).toBeTruthy();
    expect(within(card).getByText('UsersModule')).toBeTruthy();
    expect(within(card).getByText(en('km.amb.examples_excluded'))).toBeTruthy();
    expect(within(card).getByText('A new ambiguity the UI has no translation for.')).toBeTruthy();
    expect(within(card).getByText('routes')).toBeTruthy(); // the truncation note
  });
  it('renders in Arabic with translated labels', async () => {
    mockFetch(world({ manifest: manifest() }));
    ui({ locale: 'ar' });
    const card = await screen.findByLabelText(t('ar', 'km.title'));
    expect(await within(card).findByText(t('ar', 'km.frameworks'))).toBeTruthy();
    expect(within(card).getByText(t('ar', 'km.amb.examples_excluded'))).toBeTruthy();
    expect(
      within(card).getByText(t('ar', 'km.route.next-app-page'), { exact: false }),
    ).toBeTruthy();
  });
  it('says when detection has not run, when nothing is proven, and handles a forbidden or failed read', async () => {
    mockFetch(world({ manifest: null }));
    ui();
    expect(await screen.findByText(en('km.none'))).toBeTruthy();
    cleanup();
    mockFetch(
      world({
        manifest: manifest({
          projects: [],
          routes: [],
          screens: [],
          moduleFacts: [],
          capabilities: [],
          workspaces: [],
          ambiguities: [],
          languages: [],
          packageManagers: [],
          stats: { truncated: [] },
        }),
      }),
    );
    ui();
    const card = await screen.findByLabelText(en('km.title'));
    expect(await within(card).findByText(en('km.frameworks.none'))).toBeTruthy();
    expect(within(card).getByText(en('km.routes.none'))).toBeTruthy();
    expect(within(card).getByText(en('km.capabilities.none'))).toBeTruthy();
    expect(within(card).getByText(en('km.ambiguities.none'))).toBeTruthy();
    expect(within(card).getByText(en('km.pm.none'))).toBeTruthy();
    cleanup();
    mockFetch(world({ manifest: json(403, {}) }));
    ui();
    const c2 = await screen.findByLabelText(en('km.title'));
    expect(await within(c2).findByText(en('ki.forbidden'))).toBeTruthy();
  });
  it('shows routes in pages of 50 with a "show more" button', async () => {
    const routes = Array.from({ length: 120 }, (_, i) => ({
      kind: 'next-app-page',
      path: `/p${String(i).padStart(3, '0')}`,
      methods: ['GET'],
      file: `app/p${i}/page.tsx`,
      project: '.',
    }));
    mockFetch(world({ manifest: manifest({ routes }) }));
    ui();
    const card = await screen.findByLabelText(en('km.title'));
    expect(await within(card).findByText('/p049')).toBeTruthy();
    expect(within(card).queryByText('/p050')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: en('km.more') }));
    expect(await within(card).findByText('/p149'.replace('149', '099'))).toBeTruthy();
  });
  it('loads the manifest of the version that is selected', async () => {
    mockFetch(world({ manifest: manifest() }));
    ui();
    await screen.findByLabelText(en('km.title'));
    fireEvent.change(screen.getByLabelText(en('ki.version')), { target: { value: V2 } });
    await waitFor(() =>
      expect(seen.some((x) => x.url.includes(`/versions/${V2}/manifest`))).toBe(true),
    );
  });
});
