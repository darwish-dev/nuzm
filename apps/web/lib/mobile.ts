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
/** the same limit as every first project description (`PROJECT_PROMPT_MAX`) */
export const DESCRIPTION_MAX = 30_000;
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

/* ------------------------------------------------------------------ workspace (the mobile app opens in the builder workspace) */

/** The panels of the mobile workspace, in the order of its top bar. `preview`, `code` and `spec` need `builder:read`; the others the permission of the old pages. */
export const WORKSPACE_TABS = ['preview', 'code', 'spec', 'builds', 'signing', 'releases'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const TAB_PERMISSION: Record<WorkspaceTab, string> = {
  preview: 'builder:read',
  code: 'builder:read',
  spec: 'builder:read',
  builds: 'mobile:build',
  signing: 'mobile:signing',
  releases: 'mobile:release',
};
/** `?tab=` of the workspace route; anything else opens the preview. */
export function workspaceTab(raw: string | string[] | undefined): WorkspaceTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (WORKSPACE_TABS as readonly string[]).includes(v ?? '') ? (v as WorkspaceTab) : 'preview';
}
/** The tabs a member may open (the signing tab only with `mobile:signing`, and so on). */
export const tabsFor = (can: (permission: string) => boolean): WorkspaceTab[] =>
  WORKSPACE_TABS.filter((x) => can(TAB_PERMISSION[x]));

/** The route a former mobile page now lives at (the old routes redirect here, so existing links keep working). */
export const workspaceHref = (
  locale: string,
  projectId: string,
  tab?: string,
  extra?: Record<string, string>,
): string => {
  const q = new URLSearchParams({ ...(tab ? { tab } : {}), ...(extra ?? {}) }).toString();
  return `/builder/projects/${projectId}${q ? `?${q}` : ''}`;
};

/* ---- the design, as the preview draws it */

export interface Bi {
  ar: string;
  en: string;
}
export interface PreviewField {
  id: string;
  label: Bi;
  type: string;
  required: boolean;
  options: { value: string; label: Bi }[];
}
export interface PreviewScreen {
  id: string;
  kind: string;
  title: Bi;
  body: Bi | null;
  fields: PreviewField[];
  items: { title: Bi; subtitle: Bi | null }[];
}
export interface PreviewSpec {
  app: { name: Bi; packageId: string; description: Bi | null };
  theme: { primary: string; secondary: string | null; dark: boolean };
  defaultLocale: 'ar' | 'en';
  auth: boolean;
  screens: PreviewScreen[];
  navigation: { initial: string; tabs: string[] };
  permissions: string[];
}
const HEX = /^#[0-9A-Fa-f]{6}$/;
const biOf = (v: unknown, max = 400): Bi | null =>
  isObj(v) && (typeof v.ar === 'string' || typeof v.en === 'string')
    ? { ar: str(v.ar, max), en: str(v.en, max) }
    : null;
/** The text of a bilingual value in the language shown, falling back to the other one (a design always has both, a malformed one may not). */
export const biText = (b: Bi | null | undefined, locale: 'ar' | 'en'): string =>
  b ? (locale === 'ar' ? b.ar || b.en : b.en || b.ar) : '';

/**
 * The mobile spec (the structured design a mobile run produced) as the preview needs it. Defensive: the spec comes from a model and was validated by the API, but
 * the screen never trusts its shape (a malformed member is dropped, a spec with no screen is `null`). Nothing in it is ever rendered as markup.
 */
export function previewSpec(raw: unknown): PreviewSpec | null {
  if (!isObj(raw) || !Array.isArray(raw.screens)) return null;
  const app = isObj(raw.app) ? raw.app : {};
  const theme = isObj(raw.theme) ? raw.theme : {};
  const nav = isObj(raw.navigation) ? raw.navigation : {};
  const screens: PreviewScreen[] = raw.screens.filter(isObj).map((s) => ({
    id: str(s.id, 40),
    kind: str(s.kind, 20),
    title: biOf(s.title, 80) ?? { ar: '', en: '' },
    body: biOf(s.body),
    fields: (Array.isArray(s.fields) ? s.fields : []).filter(isObj).map((f) => ({
      id: str(f.id, 40),
      label: biOf(f.label, 80) ?? { ar: '', en: '' },
      type: str(f.type, 20),
      required: f.required === true,
      options: (Array.isArray(f.options) ? f.options : []).filter(isObj).map((o) => ({
        value: str(o.value, 40),
        label: biOf(o.label, 80) ?? { ar: '', en: '' },
      })),
    })),
    items: (Array.isArray(s.items) ? s.items : []).filter(isObj).map((i) => ({
      title: biOf(i.title, 100) ?? { ar: '', en: '' },
      subtitle: biOf(i.subtitle, 160),
    })),
  }));
  if (screens.length === 0) return null;
  const tabs = (Array.isArray(nav.tabs) ? nav.tabs : [])
    .filter((x): x is string => typeof x === 'string')
    .filter((id) => screens.some((s) => s.id === id))
    .slice(0, 5);
  const initial = screens.some((s) => s.id === nav.initial) ? str(nav.initial, 40) : screens[0]!.id;
  return {
    app: {
      name: biOf(app.name, 60) ?? { ar: '', en: '' },
      packageId: str(app.packageId, 80),
      description: biOf(app.description, 300),
    },
    theme: {
      primary:
        typeof theme.primary === 'string' && HEX.test(theme.primary) ? theme.primary : '#0f766e',
      secondary:
        typeof theme.secondary === 'string' && HEX.test(theme.secondary) ? theme.secondary : null,
      dark: theme.dark === true,
    },
    defaultLocale: raw.defaultLocale === 'en' ? 'en' : 'ar',
    auth: isObj(raw.auth) && raw.auth.enabled === true,
    screens,
    navigation: { initial, tabs: tabs.length > 0 ? tabs : [initial] },
    permissions: (Array.isArray(raw.permissions) ? raw.permissions : []).filter(
      (x): x is string => typeof x === 'string',
    ),
  };
}
/** The spec stored in a mobile project's manifest (`null` for an empty project). */
export const manifestSpec = (manifest: unknown): PreviewSpec | null =>
  previewSpec(isObj(manifest) ? manifest.spec : null);

/** Black or white text, whichever reads better on the colour (WCAG relative luminance). */
export function onColor(hex: string): '#111827' | '#ffffff' {
  if (!HEX.test(hex)) return '#ffffff';
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return lum > 0.36 ? '#111827' : '#ffffff';
}

/* ---- the design awaiting approval, and the run's progress */

export interface MobileApprovalView {
  appName: Bi | null;
  applicationId: string | null;
  screens: { id: string; kind: string; title: Bi }[];
  tabs: string[];
  permissions: string[];
  /** the stored design (run artifact) the preview can draw while the person decides */
  artifactId: string | null;
}
/** The summary of a pending `plan` approval of a mobile run, read defensively (the stored payload is never part of it). */
export function mobileApprovalView(summary: unknown): MobileApprovalView {
  const s = isObj(summary) ? summary : {};
  return {
    appName: biOf(s.appName, 60),
    applicationId: str(s.applicationId, 80) || null,
    screens: (Array.isArray(s.screens) ? s.screens : []).filter(isObj).map((x) => ({
      id: str(x.id, 40),
      kind: str(x.kind, 20),
      title: biOf(x.title, 80) ?? { ar: '', en: '' },
    })),
    tabs: (Array.isArray(s.tabs) ? s.tabs : []).filter((x): x is string => typeof x === 'string'),
    permissions: (Array.isArray(s.permissions) ? s.permissions : []).filter(
      (x): x is string => typeof x === 'string',
    ),
    artifactId:
      typeof s.artifactId === 'string' && /^[0-9a-f-]{36}$/i.test(s.artifactId)
        ? s.artifactId
        : null,
  };
}

/** Why a run failed: its code, the short message the service recorded and the (at most 8) reasons it gave. Strings are masked, never raw model output. */
export function runFailure(error: unknown): {
  code: string | null;
  message: string | null;
  details: string[];
} {
  const e = isObj(error) ? error : {};
  const mask = (v: unknown, max: number) =>
    typeof v === 'string'
      ? v
          .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[REDACTED]')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, max)
      : '';
  return {
    code: typeof e.code === 'string' ? e.code.slice(0, 60) : null,
    message: mask(e.message, 240) || null,
    details: (Array.isArray(e.details) ? e.details : [])
      .map((d) => mask(d, 160))
      .filter((d) => d !== '')
      .slice(0, 8),
  };
}

export const MOBILE_STAGES = ['design', 'approval', 'generate', 'analysis'] as const;
export type MobileStageId = (typeof MOBILE_STAGES)[number];
export interface MobileStage {
  id: MobileStageId;
  state: 'done' | 'active' | 'failed' | 'pending';
}
/** What the run is doing, in words a person uses (the title of the card). */
export type MobilePhase =
  'queued' | 'designing' | 'approval' | 'generating' | 'done' | 'failed' | 'cancelled' | 'budget';
export function mobilePhase(state: string, events: { type: string }[]): MobilePhase {
  const approved = events.some((e) => e.type === 'approval_approved');
  if (state === 'succeeded') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'budget_exceeded') return 'budget';
  if (state === 'waiting_approval') return 'approval';
  if (approved) return 'generating';
  return state === 'queued' ? 'queued' : 'designing';
}
/**
 * The steps of a `mobile` run as the events and the run state show them: the design, the person's approval, the Flutter project, its static analysis. The service
 * gives no event between writing the files and the analysis (one step), so "analysis" is marked done only when the run succeeded (a failed analysis fails the run);
 * nothing is claimed that did not happen. A failed run marks the step it stopped at.
 */
export function mobileRunStages(
  state: string,
  events: { type: string }[],
  error?: unknown,
): MobileStage[] {
  const phase = mobilePhase(state, events);
  const approved = events.some((e) => e.type === 'approval_approved');
  const asked = events.some((e) => e.type === 'approval_requested') || approved;
  const failedAt = (): number => {
    const msg = `${runFailure(error).message ?? ''} ${runFailure(error).details.join(' ')}`;
    if (/analysis/i.test(msg)) return 3;
    return approved ? 2 : asked ? 1 : 0;
  };
  const current =
    phase === 'queued' || phase === 'designing'
      ? 0
      : phase === 'approval'
        ? 1
        : phase === 'generating'
          ? 2
          : phase === 'done'
            ? 4
            : failedAt();
  const bad = phase === 'failed' || phase === 'cancelled' || phase === 'budget';
  return MOBILE_STAGES.map((id, i) => ({
    id,
    state: i < current ? 'done' : i === current ? (bad ? 'failed' : 'active') : 'pending',
  }));
}
