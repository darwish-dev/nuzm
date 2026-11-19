// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { MobileBuild, MobileRelease, SigningCredential } from '../lib/mobile';
import { MobileBuilds } from './MobileBuilds';
import { MobileSpecPane } from './MobileSpecPane';
import { MobileReleases } from './MobileReleases';
import { ReleaseWizard } from './MobileReleaseWizard';
import { MobileSigning } from './MobileSigning';
import { MobileStart } from './MobileStart';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
const mockFetch = (h: (url: string, n: number) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, calls.length);
    }),
  );
};
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

const P = '018f0000-0000-7000-8000-0000000000aa';
// built at run time: a literal key header would trip the repository secret scanner
const PEM_HEAD = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const USER = '018f0000-0000-7000-8000-000000000001';
const build = (o: Partial<MobileBuild> = {}): MobileBuild =>
  ({
    id: '018f0000-0000-7000-8000-0000000000b1',
    projectId: P,
    versionId: '018f0000-0000-7000-8000-0000000000c1',
    platform: 'android',
    profile: 'debug',
    status: 'succeeded',
    runner: 'local-android',
    isolation: 'none',
    signed: false,
    minutesBilled: 9.5,
    toolchain: {},
    notices: ['unsigned', 'not isolated: a local development runner is never isolation evidence'],
    createdAt: '2026-11-19T10:00:00.000Z',
    ...o,
  }) as MobileBuild;

describe('UI-M10-12 start a mobile app', () => {
  const fill = (name: string, desc: string) => {
    fireEvent.change(screen.getByLabelText(new RegExp(t('en', 'mobile.start.name'))), {
      target: { value: name },
    });
    fireEvent.change(screen.getByLabelText(new RegExp(t('en', 'mobile.start.description'))), {
      target: { value: desc },
    });
  };
  it('validates before anything is sent', () => {
    mockFetch(() => json(500, {}));
    render(<MobileStart locale="en" canRun />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.start.go') }));
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(0);
  });
  it('creates a mobile project, a session and a `mobile` run, then opens the overview', async () => {
    mockFetch((url) =>
      url === '/v1/builder/projects'
        ? json(201, { id: 'p1' })
        : url === '/v1/ai/sessions'
          ? json(201, { id: 's1' })
          : json(202, { id: 'r1' }),
    );
    render(<MobileStart locale="en" canRun />);
    fill('Field Tasks', 'An app for field teams');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.start.go') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/builder/projects/p1'));
    expect(calls.map((c) => c.url)).toEqual([
      '/v1/builder/projects',
      '/v1/ai/sessions',
      '/v1/ai/runs',
    ]);
    expect(calls[0]!.body).toMatchObject({
      type: 'mobile',
      name: 'Field Tasks',
      locale: ['ar', 'en'],
    });
    expect(calls[2]!.body).toMatchObject({
      kind: 'mobile',
      projectId: 'p1',
      sessionId: 's1',
      input: { description: 'An app for field teams' },
    });
    expect(calls.every((c) => c.headers['idempotency-key'])).toBe(true);
  });
  it('after a failed run request the retry reuses the project and session (no second project)', async () => {
    let runs = 0;
    mockFetch((url) => {
      if (url === '/v1/builder/projects') return json(201, { id: 'p1' });
      if (url === '/v1/ai/sessions') return json(201, { id: 's1' });
      runs += 1;
      return runs === 1 ? json(402, { code: 'insufficient_credits' }) : json(202, { id: 'r1' });
    });
    render(<MobileStart locale="en" canRun />);
    fill('Field Tasks', 'An app for field teams');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.start.go') }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.start.go') }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(calls.filter((c) => c.url === '/v1/builder/projects')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/ai/sessions')).toHaveLength(1);
  });
  it('says plainly that the design is a model proposal and that the person approves it; no write permission → read-only notice', () => {
    render(<MobileStart locale="en" canRun />);
    expect(screen.getByText(t('en', 'mobile.start.modelNote'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.start.next'))).toBeTruthy();
    cleanup();
    render(<MobileStart locale="ar" canRun={false} />);
    expect(screen.getByText(t('ar', 'mobile.start.noPermission'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('UI-M10-13 spec panel (the approved design in plain terms)', () => {
  const manifest = {
    fileCount: 22,
    generator: { flutter: '3.35.7', dart: '3.9.2' },
    spec: {
      app: { name: { ar: 'مهام', en: 'Tasks' }, packageId: 'sa.nuzm.tasks' },
      theme: { primary: '#0B6E4F', dark: true },
      defaultLocale: 'ar',
      auth: { enabled: true },
      screens: [{ id: 'home', kind: 'home', title: { ar: 'الرئيسية', en: 'Home' } }],
      navigation: { initial: 'home', tabs: ['home'] },
      permissions: [],
    },
  };
  it('lists the app id, theme, sign-in, permissions and every screen with its kind', () => {
    render(<MobileSpecPane locale="en" manifest={manifest} />);
    expect(screen.getByText('sa.nuzm.tasks')).toBeTruthy();
    expect(screen.getByText('#0B6E4F')).toBeTruthy();
    expect(screen.getByText(t('en', 'mws.spec.authOn'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.wizard.permission.internet'))).toBeTruthy();
    expect(screen.getAllByText('Home').length).toBeGreaterThan(0); // the title (and the kind label)
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('Arabic shows Arabic titles; an empty project shows the empty state', () => {
    render(<MobileSpecPane locale="ar" manifest={manifest} />);
    expect(screen.getByText('الرئيسية')).toBeTruthy();
    cleanup();
    render(<MobileSpecPane locale="en" manifest={{ kind: 'mobile', fileCount: 0, spec: null }} />);
    expect(screen.getByText(t('en', 'mobile.preview.empty.title'))).toBeTruthy();
  });
});

describe('UI-M10-14 builds', () => {
  it('empty state, and what each build IS (unsigned, not isolated) is printed with it', () => {
    render(<MobileBuilds locale="en" projectId={P} initial={[]} hasProject canBuild />);
    expect(screen.getByText(t('en', 'mobile.builds.empty.title'))).toBeTruthy();
    cleanup();
    render(<MobileBuilds locale="en" projectId={P} initial={[build()]} hasProject canBuild />);
    expect(screen.getByText(t('en', 'mobile.notice.unsigned'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.notice.notIsolated'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.builds.status.succeeded'))).toBeTruthy();
  });
  it('requests an Android debug build with an idempotency key and lists it as queued', async () => {
    mockFetch(() => json(202, build({ id: 'b2', status: 'queued', notices: ['unsigned'] })));
    render(<MobileBuilds locale="en" projectId={P} initial={[]} hasProject canBuild />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.builds.go') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mobile.builds.queued'))).toBeTruthy());
    expect(calls[0]).toMatchObject({
      url: '/v1/mobile/builds',
      method: 'POST',
      body: { projectId: P, platform: 'android', profile: 'debug' },
    });
    expect(calls[0]!.headers['idempotency-key']).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.builds.status.queued'))).toBeTruthy();
  });
  it('iOS: the notice is shown up front and a 503 no_macos_capacity is explained, never a fake success', async () => {
    mockFetch(() => json(503, { code: 'no_macos_capacity' }));
    render(<MobileBuilds locale="en" projectId={P} initial={[]} hasProject canBuild />);
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.builds.platform')), {
      target: { value: 'ios' },
    });
    expect(screen.getByText(t('en', 'mobile.builds.iosNotice'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.builds.go') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mobile.err.noMacos'))).toBeTruthy());
    expect(screen.queryByText(t('en', 'mobile.builds.queued'))).toBeNull();
  });
  it('release: 422 signing_not_authorized and 503 signing_unavailable have their own explanations', async () => {
    mockFetch((_u, n) =>
      n === 1
        ? json(422, { code: 'signing_not_authorized' })
        : json(503, { code: 'signing_unavailable' }),
    );
    render(<MobileBuilds locale="ar" projectId={P} initial={[]} hasProject canBuild />);
    fireEvent.change(screen.getByLabelText(t('ar', 'mobile.builds.profile')), {
      target: { value: 'release' },
    });
    expect(screen.getByText(t('ar', 'mobile.builds.releaseNotice'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'mobile.builds.go') }));
    await waitFor(() =>
      expect(screen.getByText(t('ar', 'mobile.err.signingNotAuthorized'))).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'mobile.builds.go') }));
    await waitFor(() =>
      expect(screen.getByText(t('ar', 'mobile.err.signingUnavailable'))).toBeTruthy(),
    );
  });
  it('no generated project → the request is disabled with the reason; a viewer without mobile:build sees no request form', () => {
    render(<MobileBuilds locale="en" projectId={P} initial={[]} hasProject={false} canBuild />);
    expect(screen.getByText(t('en', 'mobile.builds.noProject'))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: t('en', 'mobile.builds.go') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    cleanup();
    render(
      <MobileBuilds locale="en" projectId={P} initial={[build()]} hasProject canBuild={false} />,
    );
    expect(screen.queryByRole('button', { name: t('en', 'mobile.builds.go') })).toBeNull();
  });
  it('shows the artifacts of a finished build with checksum and no download link; a failed load says so', async () => {
    const sha = 'a'.repeat(64);
    mockFetch(() =>
      json(200, {
        items: [
          {
            id: 'a1',
            buildId: 'b1',
            kind: 'apk',
            fileName: 'app-debug.apk',
            sha256: sha,
            sizeBytes: 2048,
            signed: false,
            retentionUntil: '2026-12-19T00:00:00.000Z',
            createdAt: '2026-11-19T10:00:00.000Z',
          },
        ],
      }),
    );
    render(<MobileBuilds locale="en" projectId={P} initial={[build()]} hasProject canBuild />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.builds.artifacts') }));
    await waitFor(() => expect(screen.getByText('app-debug.apk')).toBeTruthy());
    expect(screen.getByText(sha)).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.builds.artifactsNote'))).toBeTruthy();
    expect(document.querySelector('a[download]')).toBeNull();
  });
  it('a failed build shows its error code and the redacted log', () => {
    render(
      <MobileBuilds
        locale="en"
        projectId={P}
        initial={[
          build({
            status: 'failed',
            errorCode: 'dependency_blocked',
            log: 'lockfile ok\n[line removed: possible secret]',
          }),
        ]}
        hasProject
        canBuild
      />,
    );
    expect(screen.getByText('dependency_blocked')).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toContain('[line removed: possible secret]');
  });
  it('polls a queued build until it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch(() => json(200, { items: [build({ status: 'succeeded' })] }));
      render(
        <MobileBuilds
          locale="en"
          projectId={P}
          initial={[build({ status: 'queued' })]}
          hasProject
          canBuild
        />,
      );
      expect(screen.getByText(t('en', 'mobile.builds.status.queued'))).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3100);
      await waitFor(() =>
        expect(screen.getByText(t('en', 'mobile.builds.status.succeeded'))).toBeTruthy(),
      );
      expect(calls[0]!.url).toContain('/v1/mobile/builds');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UI-M10-15 signing references (a reference, never key material)', () => {
  const cred = (): SigningCredential =>
    ({
      id: 'c1',
      platform: 'android',
      label: 'Play key',
      vaultRef: 'vault://org/mobile/play',
      authorizedBy: USER,
      authorizedAt: '2026-11-19T10:00:00.000Z',
      revokedAt: null,
      usable: true,
    }) as SigningCredential;
  it('has exactly platform, label and vault reference inputs: no key, keystore, certificate or password field', () => {
    render(<MobileSigning locale="en" userId={USER} initial={[]} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(document.querySelector('input[type=password], input[type=file], textarea')).toBeNull();
    expect(screen.getByText(t('en', 'mobile.signing.empty.title'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.signing.vaultRefHelp'))).toBeTruthy();
  });
  it('sends the reference with authorizedBy = the signed-in user', async () => {
    mockFetch(() => json(201, cred()));
    render(<MobileSigning locale="en" userId={USER} initial={[]} />);
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.signing.label')), {
      target: { value: 'Play key' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.signing.vaultRef')), {
      target: { value: 'vault://org/mobile/play' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.signing.create') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mobile.signing.created'))).toBeTruthy());
    expect(calls[0]).toMatchObject({
      url: '/v1/mobile/signing-credentials',
      method: 'POST',
      body: {
        platform: 'android',
        label: 'Play key',
        vaultRef: 'vault://org/mobile/play',
        authorizedBy: USER,
      },
    });
    expect(screen.getByText('vault://org/mobile/play')).toBeTruthy();
  });
  it('pasted key material is refused in the browser: nothing is sent and the field is cleared', () => {
    mockFetch(() => json(201, cred()));
    render(<MobileSigning locale="en" userId={USER} initial={[]} />);
    const ref = screen.getByLabelText(t('en', 'mobile.signing.vaultRef')) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.signing.label')), {
      target: { value: 'Key' },
    });
    fireEvent.change(ref, {
      target: { value: `${PEM_HEAD}MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw` },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.signing.create') }));
    expect(screen.getByText(t('en', 'mobile.signing.err.rawSecret'))).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(ref.value).toBe('');
  });
  it('a 422 raw_secret_rejected from the service is explained and clears the field; the value is never shown', async () => {
    mockFetch(() =>
      json(422, { code: 'raw_secret_rejected', detail: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw' }),
    );
    render(<MobileSigning locale="en" userId={USER} initial={[]} />);
    const ref = screen.getByLabelText(t('en', 'mobile.signing.vaultRef')) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.signing.label')), {
      target: { value: 'Key' },
    });
    fireEvent.change(ref, { target: { value: 'vault://org/mobile/play' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.signing.create') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mobile.err.rawSecret'))).toBeTruthy());
    expect(ref.value).toBe('');
    expect(document.body.textContent).not.toContain('MIIEvQIBADANBgkq');
  });
  it('revoke is not offered: the screen explains it needs a spec change (SCR-M10B-01)', () => {
    render(<MobileSigning locale="en" userId={USER} initial={[cred()]} />);
    expect(screen.getByText(t('en', 'mobile.signing.revokeNote'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
    expect(screen.getByText(t('en', 'mobile.signing.usable'))).toBeTruthy();
  });
});

describe('UI-M10-16 releases list', () => {
  const rel = (o: Partial<MobileRelease> = {}): MobileRelease =>
    ({
      id: 'r1',
      projectId: P,
      buildId: 'b1',
      versionName: '1.0.0',
      versionCode: 3,
      store: 'google_play',
      status: 'draft',
      checklist: {},
      metadata: {},
      scopeHash: null,
      ownerApprovedBy: null,
      ownerApprovedAt: null,
      missing: ['screenshots_en'],
      notices: [],
      createdAt: '2026-11-19T10:00:00.000Z',
      updatedAt: '2026-11-19T10:00:00.000Z',
      etag: 1,
      ...o,
    }) as MobileRelease;
  it('empty state and the permanent no-submission statement', () => {
    render(<MobileReleases locale="en" projectId={P} items={[]} canCreate />);
    expect(screen.getByText(t('en', 'mobile.releases.empty.title'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.releases.noSubmit'))).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('en', 'mobile.releases.new') }).getAttribute('href'),
    ).toBe(`/en/mobile/${P}/releases/new`);
  });
  it('shows status, store and what a draft still misses; a reader without mobile:release cannot create', () => {
    render(
      <MobileReleases
        locale="en"
        projectId={P}
        items={[rel(), rel({ id: 'r2', status: 'owner_approved', versionCode: 4, missing: [] })]}
        canCreate={false}
      />,
    );
    expect(screen.getByText(t('en', 'mobile.releases.status.draft'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.releases.status.owner_approved'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.missing.screenshots_en'))).toBeTruthy();
    expect(screen.queryByRole('link', { name: t('en', 'mobile.releases.new') })).toBeNull();
  });
});

describe('UI-M10-17 release wizard (prepares; never submits)', () => {
  const builds = [build()];
  const submitLike = /submit|send to|publish|approve now|store review/i;
  it('shows the four steps, the owner-approval statement and the no-submission notice; the only buttons save a record', () => {
    render(<ReleaseWizard locale="en" projectId={P} builds={builds} declared={['internet']} />);
    expect(screen.getByText(t('en', 'mobile.wizard.ownerNote'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.releases.noSubmit'))).toBeTruthy();
    expect(
      screen
        .getAllByRole('listitem')
        .map((l) => l.textContent)
        .join(' '),
    ).toContain(t('en', 'mobile.wizard.step.store'));
    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names).toEqual(
      expect.arrayContaining([
        t('en', 'mobile.wizard.saveDraft'),
        t('en', 'mobile.wizard.savePrepared'),
      ]),
    );
    for (const n of names) expect(n, n).not.toMatch(submitLike);
  });
  it('no successful build → empty state, no form', () => {
    render(
      <ReleaseWizard
        locale="en"
        projectId={P}
        builds={[build({ status: 'failed' })]}
        declared={['internet']}
      />,
    );
    expect(screen.getByText(t('en', 'mobile.wizard.buildNone'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'mobile.wizard.saveDraft') })).toBeNull();
  });
  it('saves a draft and names what is still missing', async () => {
    mockFetch(() =>
      json(201, {
        id: 'r1',
        status: 'draft',
        versionName: '1.0.0',
        versionCode: 1,
        missing: ['signed_release_build', 'screenshots_ar'],
        notices: [],
      }),
    );
    render(<ReleaseWizard locale="en" projectId={P} builds={builds} declared={['internet']} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.wizard.saveDraft') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mobile.wizard.saved'))).toBeTruthy());
    expect(calls[0]!.url).toBe('/v1/mobile/releases');
    expect(calls[0]!.body).toMatchObject({
      projectId: P,
      status: 'draft',
      store: 'google_play',
      versionName: '1.0.0',
      versionCode: 1,
    });
    expect(calls[0]!.headers['idempotency-key']).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.missing.signed_release_build'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mobile.missing.screenshots_ar'))).toBeTruthy();
  });
  it('"Mark as prepared" with items missing: the 422 is explained and each item is named (Arabic too)', async () => {
    mockFetch(() =>
      json(422, {
        code: 'release_checklist_incomplete',
        errors: [
          { item: 'signed_release_build' },
          { item: 'compliance.iapPolicy' },
          { item: 'unknown_future_item' },
        ],
      }),
    );
    render(<ReleaseWizard locale="ar" projectId={P} builds={builds} declared={['internet']} />);
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'mobile.wizard.savePrepared') }));
    await waitFor(() =>
      expect(screen.getByText(t('ar', 'mobile.err.checklistIncomplete'))).toBeTruthy(),
    );
    expect(calls[0]!.body).toMatchObject({ status: 'prepared' });
    expect(screen.getByText(t('ar', 'mobile.missing.signed_release_build'))).toBeTruthy();
    expect(screen.getByText(t('ar', 'mobile.missing.compliance.iapPolicy'))).toBeTruthy();
    expect(screen.getByText('unknown_future_item')).toBeTruthy(); // an unknown item is shown as its id
  });
  it('validates the version fields before sending and builds the checklist from the inputs', async () => {
    mockFetch(() =>
      json(201, {
        id: 'r1',
        status: 'draft',
        versionName: '2.0.0',
        versionCode: 7,
        missing: [],
        notices: [],
      }),
    );
    render(
      <ReleaseWizard locale="en" projectId={P} builds={builds} declared={['internet', 'camera']} />,
    );
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.wizard.versionName')), {
      target: { value: '2.0' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.wizard.saveDraft') }));
    expect(screen.getByText(t('en', 'mobile.wizard.err.versionName'))).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.wizard.versionName')), {
      target: { value: '2.0.0' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.wizard.versionCode')), {
      target: { value: '7' },
    });
    fireEvent.change(
      screen.getByLabelText(new RegExp(`${t('en', 'mobile.wizard.permission.camera')} — `)),
      { target: { value: 'scan a code' } },
    );
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.wizard.privacy')), {
      target: { value: 'https://example.com/privacy' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.wizard.shotAdd') }));
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.wizard.shotRef')), {
      target: { value: 'shots/a.png' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.wizard.shotSha')), {
      target: { value: 'b'.repeat(64) },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.wizard.saveDraft') }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({
      versionName: '2.0.0',
      versionCode: 7,
      checklist: {
        privacyPolicyUrl: 'https://example.com/privacy',
        permissions: [{ permission: 'camera', justification: 'scan a code' }],
        screenshots: [
          { locale: 'ar', device: 'phone', ref: 'shots/a.png', sha256: 'b'.repeat(64) },
        ],
      },
    });
  });
  it('a copy that promises a store outcome is refused by the service and the screen says to describe the app instead', async () => {
    mockFetch(() => json(422, { code: 'validation_failed' }));
    render(<ReleaseWizard locale="en" projectId={P} builds={builds} declared={['internet']} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.wizard.saveDraft') }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByText(t('en', 'mobile.wizard.copyHint'))).toBeTruthy();
  });
});
