import { describe, expect, it } from 'vitest';
// the catalogue file itself (the package does not export it): the test inspects every mobile key
import { messages } from '../../../packages/i18n/src/messages';
import {
  buildBody,
  buildTone,
  declaredPermissions,
  emptyReleaseForm,
  isLiveBuild,
  manifestView,
  minutesText,
  missingItemsOf,
  mobileProblemKey,
  noticeKey,
  orderLocales,
  releaseBody,
  releaseTone,
  sizeText,
  stepOf,
  validDescription,
  validateReleaseForm,
  validateSigning,
} from './mobile';
import type { BuilderProblem } from './builder';

const P = (o: Partial<BuilderProblem>): BuilderProblem => ({ status: 400, issues: [], ...o });
const USER = '018f0000-0000-7000-8000-000000000001';

describe('problems', () => {
  it('maps the mobile codes to their own messages, never to raw server text', () => {
    expect(mobileProblemKey(P({ status: 422, code: 'signing_not_authorized' }))).toBe(
      'mobile.err.signingNotAuthorized',
    );
    expect(mobileProblemKey(P({ status: 503, code: 'signing_unavailable' }))).toBe(
      'mobile.err.signingUnavailable',
    );
    expect(mobileProblemKey(P({ status: 503, code: 'no_macos_capacity' }))).toBe(
      'mobile.err.noMacos',
    );
    expect(mobileProblemKey(P({ status: 503, code: 'build_runner_unavailable' }))).toBe(
      'mobile.err.noRunner',
    );
    expect(mobileProblemKey(P({ status: 422, code: 'raw_secret_rejected' }))).toBe(
      'mobile.err.rawSecret',
    );
    expect(mobileProblemKey(P({ status: 422, code: 'release_checklist_incomplete' }))).toBe(
      'mobile.err.checklistIncomplete',
    );
    expect(mobileProblemKey(P({ status: 0 }))).toBe('mobile.err.offline');
    expect(mobileProblemKey(P({ status: 503 }))).toBe('mobile.err.unavailable');
    expect(mobileProblemKey(P({ status: 403 }))).toBe('state.forbidden.title');
  });
  it('reads the named checklist items of a 422 and drops anything malformed', () => {
    expect(
      missingItemsOf({
        errors: [
          { item: 'screenshots_en' },
          { item: 'compliance.iapPolicy' },
          { item: '<script>' },
          7,
          null,
          { x: 1 },
        ],
      }),
    ).toEqual(['screenshots_en', 'compliance.iapPolicy']);
    expect(missingItemsOf(undefined)).toEqual([]);
    expect(missingItemsOf({ errors: 'nope' })).toEqual([]);
  });
});

describe('builds', () => {
  it('a queued or building build is live, the others are final', () => {
    expect(['queued', 'building'].every(isLiveBuild)).toBe(true);
    expect(['succeeded', 'failed', 'blocked'].some(isLiveBuild)).toBe(false);
    expect(buildTone('succeeded')).toBe('success');
    expect(buildTone('failed')).toBe('danger');
    expect(buildTone('blocked')).toBe('warn');
  });
  it('the request body only takes the closed lists', () => {
    expect(buildBody('p', 'android', 'debug')).toEqual({
      projectId: 'p',
      platform: 'android',
      profile: 'debug',
    });
    expect(buildBody('p', 'windows', 'debug')).toBeNull();
    expect(buildBody('p', 'ios', 'nightly')).toBeNull();
  });
  it('knows the notices the service sends and leaves the others alone', () => {
    expect(noticeKey('unsigned')).toBe('mobile.notice.unsigned');
    expect(noticeKey('not isolated: a local development runner is never isolation evidence')).toBe(
      'mobile.notice.notIsolated',
    );
    expect(noticeKey('mock runner: not a real build')).toBe('mobile.notice.mock');
    expect(noticeKey('iOS builds need macOS capacity (D-22 / HG-10-01)')).toBe('mobile.notice.ios');
    expect(noticeKey('something new')).toBeNull();
  });
  it('formats minutes and sizes without hiding short builds', () => {
    expect(minutesText(0)).toBe('0');
    expect(minutesText(0.0123)).toBe('0.012');
    expect(minutesText(9.5)).toBe('9.50');
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(151_721_417)).toBe('144.7 MB');
  });
});

describe('signing references: a reference and nothing else', () => {
  const ok = {
    platform: 'android',
    label: 'Play upload key',
    vaultRef: 'vault://org/mobile/android-upload',
  };
  it('accepts a vault reference and authorizes it as the signed-in user', () => {
    expect(validateSigning(ok, USER)).toEqual({ ok: true, body: { ...ok, authorizedBy: USER } });
  });
  it('refuses anything that is not a vault reference', () => {
    for (const ref of [
      '',
      'file:///etc/key.p12',
      'https://vault.example/x',
      'vault://',
      'vault://a',
      'keystore.jks',
    ])
      expect(validateSigning({ ...ok, vaultRef: ref }, USER), ref).toEqual({
        ok: false,
        error: 'vaultFormat',
      });
    expect(validateSigning({ ...ok, platform: 'web' }, USER)).toEqual({
      ok: false,
      error: 'vaultFormat',
    });
    expect(validateSigning({ ...ok, label: '  ' }, USER)).toEqual({ ok: false, error: 'label' });
    expect(validateSigning({ ...ok, label: 'x '.repeat(51) }, USER)).toEqual({
      ok: false,
      error: 'label',
    });
  });
  it('catches key material before it is sent: PEM blocks and long key-like runs, in either field', () => {
    const blob = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'; // key-like run (not a real key)
    for (const v of [
      { vaultRef: `-----BEGIN PRIVATE KEY-----${blob}` },
      { vaultRef: `vault://org/${blob}` },
      { label: blob },
      { label: '-----BEGIN CERTIFICATE-----' },
    ])
      expect(validateSigning({ ...ok, ...v }, USER), JSON.stringify(v)).toEqual({
        ok: false,
        error: 'rawSecret',
      });
  });
  it('the body never has a member other than the four of the contract', () => {
    const r = validateSigning(ok, USER);
    expect(r.ok && Object.keys(r.body).sort()).toEqual([
      'authorizedBy',
      'label',
      'platform',
      'vaultRef',
    ]);
  });
});

describe('start', () => {
  it('description bounds and language order', () => {
    expect(validDescription('ab')).toBe(false);
    expect(validDescription('app')).toBe(true);
    expect(validDescription('x'.repeat(600))).toBe(true);
    expect(validDescription('x'.repeat(601))).toBe(false);
    expect(orderLocales(['en', 'ar'])).toEqual(['ar', 'en']);
    expect(orderLocales(['en'])).toEqual(['en']);
  });
});

describe('manifest', () => {
  const m = {
    kind: 'mobile',
    fileCount: 22,
    generator: { flutter: '3.35.7', dart: '3.9.2', templateSet: 'nuzm-flutter-core@1.0.0' },
    spec: {
      app: { name: { ar: 'مهام', en: 'Tasks' }, packageId: 'sa.nuzm.tasks' },
      screens: [{ id: 'home', kind: 'home', title: { ar: 'الرئيسية', en: 'Home' } }],
      navigation: { initial: 'home', tabs: ['home'] },
      permissions: ['camera'],
    },
  };
  it('extracts what the screens show and always declares internet', () => {
    const v = manifestView(m);
    expect(v).toMatchObject({ fileCount: 22, applicationId: 'sa.nuzm.tasks', tabs: ['home'] });
    expect(v.screens[0]!.title.en).toBe('Home');
    expect(v.toolchain.flutter).toBe('3.35.7');
    expect(declaredPermissions(v)).toEqual(['internet', 'camera']);
  });
  it('tolerates an empty project and malformed input', () => {
    for (const x of [
      null,
      undefined,
      5,
      'x',
      { kind: 'mobile', fileCount: 0, spec: null },
      { spec: { screens: 'no', permissions: 4 } },
    ]) {
      const v = manifestView(x);
      expect(v.screens).toEqual([]);
      expect(declaredPermissions(v)).toEqual(['internet']);
    }
  });
});

describe('release form', () => {
  const base = () => ({
    ...emptyReleaseForm(['internet']),
    buildId: '018f0000-0000-7000-8000-0000000000aa',
  });
  it('only blocks what the service cannot accept; an incomplete checklist is allowed for a draft', () => {
    expect(validateReleaseForm(base())).toEqual([]);
    expect(validateReleaseForm({ ...base(), buildId: '' })).toEqual(['build']);
    expect(validateReleaseForm({ ...base(), versionName: '1.0' })).toEqual(['versionName']);
    expect(validateReleaseForm({ ...base(), versionCode: '0' })).toEqual(['versionCode']);
    expect(validateReleaseForm({ ...base(), versionCode: '1e3' })).toEqual(['versionCode']);
    expect(validateReleaseForm({ ...base(), store: 'play' })).toEqual(['store']);
  });
  it('a draft body carries only what was entered, and never a status other than draft/prepared', () => {
    const b = releaseBody('p1', base(), 'draft');
    expect(b).toMatchObject({
      projectId: 'p1',
      status: 'draft',
      store: 'google_play',
      versionCode: 1,
      checklist: {},
      metadata: {},
    });
    expect(Object.keys(b).sort()).toEqual([
      'buildId',
      'checklist',
      'metadata',
      'projectId',
      'status',
      'store',
      'versionCode',
      'versionName',
    ]);
    expect(releaseBody('p1', base(), 'prepared').status).toBe('prepared');
  });
  it('a full form maps to the checklist and listing shape of the API', () => {
    const f = {
      ...base(),
      privacyPolicyUrl: ' https://example.com/privacy ',
      permissions: { internet: ' sign in ' },
      screenshots: [
        {
          locale: 'ar' as const,
          device: 'phone' as const,
          ref: 'shots/a.png',
          sha256: 'A'.repeat(64),
        },
        { locale: 'en' as const, device: 'phone' as const, ref: '', sha256: '' },
      ],
      compliance: {
        dataSafetyReviewed: true,
        ageRatingReviewed: false,
        contentRightsConfirmed: true,
        exportComplianceReviewed: true,
      },
      iapPolicy: 'assessed' as const,
      iapAssessmentRef: 'DOC-12',
      title: { ar: 'مهام', en: 'Tasks' },
      shortDescription: { ar: '', en: 'Short' },
      supportUrl: 'https://example.com/support',
    };
    const b = releaseBody('p1', f, 'prepared');
    expect(b.checklist).toEqual({
      privacyPolicyUrl: 'https://example.com/privacy',
      permissions: [{ permission: 'internet', justification: 'sign in' }],
      screenshots: [{ locale: 'ar', device: 'phone', ref: 'shots/a.png', sha256: 'a'.repeat(64) }],
      compliance: {
        dataSafetyReviewed: true,
        contentRightsConfirmed: true,
        exportComplianceReviewed: true,
        iapPolicy: { assessmentRef: 'DOC-12' },
      },
    });
    expect(b.metadata).toEqual({
      title: { ar: 'مهام', en: 'Tasks' },
      shortDescription: { ar: '', en: 'Short' },
      supportUrl: 'https://example.com/support',
    });
  });
  it('steps stop at the owner: no step makes a record "submitted"', () => {
    expect([stepOf('draft'), stepOf('prepared'), stepOf('owner_approved')]).toEqual([1, 2, 3]);
    expect(releaseTone('owner_approved')).toBe('success');
    expect(releaseTone('draft')).toBeUndefined();
  });
});

describe('messages', () => {
  const ar = messages.ar as Record<string, string>;
  const en = messages.en as Record<string, string>;
  const keys = Object.keys(en).filter((k) => k.startsWith('mobile.'));
  it('every mobile key exists in Arabic and English with the same placeholders', () => {
    expect(keys.length).toBeGreaterThan(150);
    for (const k of keys) {
      expect(ar[k], k).toBeTruthy();
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(ar[k]!), k).toEqual(ph(en[k]!));
    }
  });
  it('every checklist item a release can miss has a name in both languages', () => {
    for (const i of [
      'succeeded_build',
      'signed_release_build',
      'ios_build_for_app_store',
      'android_build_for_google_play',
      'privacy_policy_url',
      'permission_declarations_match_the_app',
      'screenshots_ar',
      'screenshots_en',
      'compliance.dataSafetyReviewed',
      'compliance.ageRatingReviewed',
      'compliance.contentRightsConfirmed',
      'compliance.exportComplianceReviewed',
      'compliance.iapPolicy',
      'metadata.title',
      'metadata.shortDescription',
      'metadata.fullDescription',
      'metadata.supportUrl',
    ])
      expect(en[`mobile.missing.${i}`], i).toBeTruthy();
  });
  it('no mobile text promises a store outcome or a way around store review (the API copy-lint test scans the same keys)', () => {
    const promise =
      /(guarantee[sd]?\b[^.\n]{0,40}\b(approv|accept|pass|publish)|(will|certain to|sure to)\s+be\s+(approved|accepted|published)|approved\s+by\s+(apple|google|the\s+(app|play)\s*store)|(skip|bypass|avoid|circumvent)\s+(the\s+)?(store\s+)?review|(instant|automatic|100\s*%)\s+approval|(ضمان|نضمن|مضمون\w*)\s+[^.\n]{0,30}(الموافقة|القبول|النشر)|(تجاوز|تخطي)\s+(\w+\s+){0,2}مراجعة)/i;
    for (const k of keys) {
      expect(promise.test(en[k]!), `en ${k}`).toBe(false);
      expect(promise.test(ar[k]!), `ar ${k}`).toBe(false);
    }
  });
});
