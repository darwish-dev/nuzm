/** Pure helpers of the mobile builder screens (UI-M10-12..17). No I/O: unit-tested in `mobile.spec.ts`. */
import { tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import type { BuilderProblem } from './builder';
import { problemKey } from './builder';
import type { Tone } from './data';

export const MOBILE_FLAG = 'mobile_builder.enabled';
export type MobileBuild = Schemas['MobileBuild'];
export type MobileArtifact = Schemas['MobileArtifact'];
export type SigningCredential = Schemas['SigningCredential'];
export type MobileRelease = Schemas['MobileRelease'];

export const PLATFORMS = ['android', 'ios'] as const;
export const PROFILES = ['debug', 'release'] as const;
export const STORES = ['google_play', 'app_store'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Profile = (typeof PROFILES)[number];
export type Store = (typeof STORES)[number];

/* ------------------------------------------------------------------ problems */

const MOBILE_PROBLEMS: Record<string, MessageKey> = {
  signing_not_authorized: 'mobile.err.signingNotAuthorized',
  signing_unavailable: 'mobile.err.signingUnavailable',
  no_macos_capacity: 'mobile.err.noMacos',
  build_runner_unavailable: 'mobile.err.noRunner',
  raw_secret_rejected: 'mobile.err.rawSecret',
  release_checklist_incomplete: 'mobile.err.checklistIncomplete',
};
/** Localized message of a failed mobile call: mobile codes first, then the builder's own mapping (never the raw server text). */
export function mobileProblemKey(p: BuilderProblem): MessageKey {
  if (p.code && MOBILE_PROBLEMS[p.code]) return MOBILE_PROBLEMS[p.code]!;
  if (p.status === 0) return 'mobile.err.offline';
  if (p.status === 503) return 'mobile.err.unavailable';
  return problemKey(p);
}

/** The checklist items a 422 `release_checklist_incomplete` names (`errors:[{item}]`); anything malformed is dropped. */
export function missingItemsOf(error: unknown): string[] {
  const list = (error as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (x && typeof x === 'object' ? (x as { item?: unknown }).item : undefined))
    .filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(x));
}
/** Display text of a checklist item: the localized name when it is a known item, else the item id itself. */
export const missingLabel = (locale: Locale, item: string): string =>
  tDynamic(locale, `mobile.missing.${item}`, item);

/* ------------------------------------------------------------------ builds */

export const LIVE_BUILD_STATES = ['queued', 'building'] as const;
export const isLiveBuild = (status: string): boolean =>
  (LIVE_BUILD_STATES as readonly string[]).includes(status);
export function buildTone(status: string): Tone {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'blocked') return 'warn';
  return undefined;
}
/** The server's `notices` are English statements of what a build is; the known ones are shown in the user's language, any other is shown as sent (masked). */
const NOTICE_KEYS: [RegExp, MessageKey][] = [
  [/^unsigned$/, 'mobile.notice.unsigned'],
  [/^not isolated/, 'mobile.notice.notIsolated'],
  [/^mock runner/, 'mobile.notice.mock'],
  [/^iOS builds need macOS/, 'mobile.notice.ios'],
];
export function noticeKey(n: string): MessageKey | null {
  return NOTICE_KEYS.find(([re]) => re.test(n))?.[1] ?? null;
}
/** Minutes billed as a short decimal ("0.42"); 3 decimals below one minute so a short build is not shown as zero. */
export const minutesText = (m: number): string =>
  !Number.isFinite(m) || m <= 0 ? '0' : m < 1 ? m.toFixed(3) : m.toFixed(2);
export const shortSha = (s: string): string =>
  /^[0-9a-f]{64}$/.test(s) ? `${s.slice(0, 12)}…` : '';
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface BuildRequest {
  projectId: string;
  platform: Platform;
  profile: Profile;
}
/** The request body of `POST /v1/mobile/builds`; null when a value is outside the closed lists. */
export function buildBody(
  projectId: string,
  platform: string,
  profile: string,
): BuildRequest | null {
  if (!(PLATFORMS as readonly string[]).includes(platform)) return null;
  if (!(PROFILES as readonly string[]).includes(profile)) return null;
  return { projectId, platform: platform as Platform, profile: profile as Profile };
}

/* ------------------------------------------------------------------ signing references */

/** Mirrors the API: a `vault://` reference of 3..253 safe characters. The API stays the authority (422 `raw_secret_rejected`). */
export const VAULT_REF = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/@:+-]{2,250}$/;
const BLOB = /[A-Za-z0-9+/=_-]{48,}/;
export type SigningError = 'label' | 'vaultFormat' | 'rawSecret';
export interface SigningInput {
  platform: string;
  label: string;
  vaultRef: string;
}
/**
 * Client-side check before anything is sent: only a vault reference passes. PEM blocks and long key-like runs are caught here so that key material pasted by mistake never
 * leaves the browser (the API repeats the check). Returns the first problem, or the body to send.
 */
export function validateSigning(
  i: SigningInput,
  userId: string,
):
  | {
      ok: true;
      body: { platform: Platform; label: string; vaultRef: string; authorizedBy: string };
    }
  | { ok: false; error: SigningError } {
  const label = i.label.trim();
  const ref = i.vaultRef.trim();
  if (
    /-----BEGIN/.test(label) ||
    /-----BEGIN/.test(ref) ||
    BLOB.test(label) ||
    BLOB.test(ref.replace(/^vault:\/\//, ''))
  )
    return { ok: false, error: 'rawSecret' };
  if (label.length < 1 || label.length > 100) return { ok: false, error: 'label' };
  if (!VAULT_REF.test(ref) || !(PLATFORMS as readonly string[]).includes(i.platform))
    return { ok: false, error: 'vaultFormat' };
  return {
    ok: true,
    body: { platform: i.platform as Platform, label, vaultRef: ref, authorizedBy: userId },
  };
}

/* ------------------------------------------------------------------ start (UI-M10-12) */

export const DESCRIPTION_MIN = 3;
export const DESCRIPTION_MAX = 600;
export const validDescription = (d: string): boolean =>
  d.trim().length >= DESCRIPTION_MIN && d.length <= DESCRIPTION_MAX;
export const validProjectName = (n: string): boolean =>
  n.trim().length >= 1 && n.trim().length <= 100;
/** Languages keep the order ar, en: the first is the default language of the app. */
export function orderLocales(selected: string[]): ('ar' | 'en')[] {
  return (['ar', 'en'] as const).filter((l) => selected.includes(l));
}

/* ------------------------------------------------------------------ manifest (UI-M10-13) */

export interface ScreenView {
  id: string;
  kind: string;
  title: { ar: string; en: string };
}
export interface ManifestView {
  fileCount: number;
  appName: { ar: string; en: string } | null;
  applicationId: string | null;
  screens: ScreenView[];
  tabs: string[];
  permissions: string[];
  toolchain: { flutter?: string; dart?: string; templateSet?: string };
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.slice(0, max) : '');
/** The part of a mobile project's manifest the screens show. Tolerates an empty project (no spec) and malformed members. */
export function manifestView(manifest: unknown): ManifestView {
  const m = isObj(manifest) ? manifest : {};
  const spec = isObj(m.spec) ? m.spec : null;
  const gen = isObj(m.generator) ? m.generator : {};
  const app = spec && isObj(spec.app) ? spec.app : null;
  const bi = (v: unknown) => (isObj(v) ? { ar: str(v.ar), en: str(v.en) } : { ar: '', en: '' });
  const screens = spec && Array.isArray(spec.screens) ? spec.screens : [];
  const nav = spec && isObj(spec.navigation) ? spec.navigation : {};
  const perms = spec && Array.isArray(spec.permissions) ? spec.permissions : [];
  return {
    fileCount: typeof m.fileCount === 'number' ? m.fileCount : 0,
    appName: app ? bi(app.name) : null,
    applicationId: app ? str(app.packageId, 80) || null : null,
    screens: screens
      .filter(isObj)
      .map((s) => ({ id: str(s.id, 40), kind: str(s.kind, 20), title: bi(s.title) })),
    tabs: Array.isArray(nav.tabs)
      ? nav.tabs.filter((x): x is string => typeof x === 'string').slice(0, 5)
      : [],
    permissions: perms.filter((x): x is string => typeof x === 'string'),
    toolchain: {
      flutter: str(gen.flutter, 20) || undefined,
      dart: str(gen.dart, 20) || undefined,
      templateSet: str(gen.templateSet, 60) || undefined,
    },
  };
}
/** The permissions an app declares: `internet` always, plus the spec's (what the release checklist must match). */
export const declaredPermissions = (m: ManifestView): string[] => [
  'internet',
  ...m.permissions.filter((p) => p !== 'internet'),
];

/* ------------------------------------------------------------------ release wizard (UI-M10-17) */

export interface ShotRow {
  locale: 'ar' | 'en';
  device: 'phone' | 'tablet';
  ref: string;
  sha256: string;
}
export interface ReleaseForm {
  buildId: string;
  store: string;
  versionName: string;
  versionCode: string;
  privacyPolicyUrl: string;
  /** permission -> justification */
  permissions: Record<string, string>;
  screenshots: ShotRow[];
  compliance: {
    dataSafetyReviewed: boolean;
    ageRatingReviewed: boolean;
    contentRightsConfirmed: boolean;
    exportComplianceReviewed: boolean;
  };
  iapPolicy: 'not_applicable' | 'assessed' | '';
  iapAssessmentRef: string;
  title: { ar: string; en: string };
  shortDescription: { ar: string; en: string };
  fullDescription: { ar: string; en: string };
  supportUrl: string;
}
export const emptyReleaseForm = (declared: string[] = ['internet']): ReleaseForm => ({
  buildId: '',
  store: 'google_play',
  versionName: '1.0.0',
  versionCode: '1',
  privacyPolicyUrl: '',
  permissions: Object.fromEntries(declared.map((p) => [p, ''])),
  screenshots: [],
  compliance: {
    dataSafetyReviewed: false,
    ageRatingReviewed: false,
    contentRightsConfirmed: false,
    exportComplianceReviewed: false,
  },
  iapPolicy: '',
  iapAssessmentRef: '',
  title: { ar: '', en: '' },
  shortDescription: { ar: '', en: '' },
  fullDescription: { ar: '', en: '' },
  supportUrl: '',
});
export const VERSION_NAME = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]{1,30})?$/;
export type ReleaseFormError = 'build' | 'store' | 'versionName' | 'versionCode';
/** Only the fields the API cannot accept at all are blocked here; incomplete checklist items are allowed (a draft keeps them, `prepared` reports each one). */
export function validateReleaseForm(f: ReleaseForm): ReleaseFormError[] {
  const e: ReleaseFormError[] = [];
  if (!/^[0-9a-f-]{36}$/i.test(f.buildId)) e.push('build');
  if (!(STORES as readonly string[]).includes(f.store)) e.push('store');
  if (!VERSION_NAME.test(f.versionName.trim())) e.push('versionName');
  const code = Number(f.versionCode);
  if (!/^[1-9]\d{0,9}$/.test(f.versionCode.trim()) || code > 2_100_000_000) e.push('versionCode');
  return e;
}
const nonEmptyBi = (b: { ar: string; en: string }) =>
  b.ar.trim() || b.en.trim() ? { ar: b.ar.trim(), en: b.en.trim() } : undefined;
/** The body of `POST /v1/mobile/releases` from the form (empty parts are left out so a draft carries only what was entered). */
export function releaseBody(projectId: string, f: ReleaseForm, status: 'draft' | 'prepared') {
  const checklist: Record<string, unknown> = {};
  if (f.privacyPolicyUrl.trim()) checklist.privacyPolicyUrl = f.privacyPolicyUrl.trim();
  const perms = Object.entries(f.permissions)
    .filter(([, j]) => j.trim())
    .map(([permission, j]) => ({ permission, justification: j.trim() }));
  if (perms.length) checklist.permissions = perms;
  const shots = f.screenshots
    .filter((s) => s.ref.trim() || s.sha256.trim())
    .map((s) => ({
      locale: s.locale,
      device: s.device,
      ref: s.ref.trim(),
      sha256: s.sha256.trim().toLowerCase(),
    }));
  if (shots.length) checklist.screenshots = shots;
  const compliance: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.compliance)) if (v) compliance[k] = true;
  if (f.iapPolicy === 'not_applicable') compliance.iapPolicy = 'not_applicable';
  if (f.iapPolicy === 'assessed' && f.iapAssessmentRef.trim())
    compliance.iapPolicy = { assessmentRef: f.iapAssessmentRef.trim() };
  if (Object.keys(compliance).length) checklist.compliance = compliance;
  const metadata: Record<string, unknown> = {};
  for (const k of ['title', 'shortDescription', 'fullDescription'] as const) {
    const v = nonEmptyBi(f[k]);
    if (v) metadata[k] = v;
  }
  if (f.supportUrl.trim()) metadata.supportUrl = f.supportUrl.trim();
  return {
    projectId,
    buildId: f.buildId,
    versionName: f.versionName.trim(),
    versionCode: Number(f.versionCode),
    store: f.store,
    status,
    checklist,
    metadata,
  };
}
export function releaseTone(status: string): Tone {
  if (status === 'owner_approved') return 'success';
  if (status === 'prepared') return 'warn';
  return undefined;
}
/** The four steps of a release, in order, and which one a record is at. Step 4 (the store submission) is never an action of the platform. */
export const RELEASE_STEPS = ['draft', 'prepared', 'owner', 'store'] as const;
export const stepOf = (status: string): number =>
  status === 'owner_approved' ? 3 : status === 'prepared' ? 2 : 1;
