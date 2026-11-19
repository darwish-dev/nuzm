export type Row = Record<string, unknown>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export const BUILDER_CONFIG = Symbol('BUILDER_CONFIG');
export interface BuilderConfig {
  /** registrable domain of the isolated preview origin: a preview is served at `<token>.<previewDomain>` (ADR-021). NOT the console or API domain. */
  previewDomain: string;
  previewScheme: 'http' | 'https';
  /** development only: the port the preview host is reached on (`http://<token>.preview.localhost:4000/`); production leaves it empty (443) */
  previewPort: string;
  /** the console origin allowed to frame a preview (CSP frame-ancestors) */
  consoleOrigin: string;
  previewTtlMinutes: number;
  maxActivePreviews: number;
  maxProjects: number;
  /** absolute base of the Nuzm-hosted form ingest endpoint written into generated pages */
  formsBaseUrl: string;
  dataRegion: string;
  projectRetentionDays: number;
  formRatePerMinute: number;
  formMaxBytes: number;
  formRetentionDays: number;
  /** salt of the ip hash of form submissions (never the address itself) */
  ipHashSalt: string;
}
export function loadBuilderConfig(env: NodeJS.ProcessEnv = process.env): BuilderConfig {
  const n = (k: string, d: number, min = 0) => {
    const v = env[k] === undefined ? d : Number(env[k]);
    return Number.isFinite(v) && v >= min ? v : d;
  };
  return {
    previewDomain: (env.BUILDER_PREVIEW_DOMAIN ?? 'preview.nuzm-preview.test').toLowerCase(),
    previewScheme: env.BUILDER_PREVIEW_SCHEME === 'http' ? 'http' : 'https',
    previewPort: /^\d{2,5}$/.test(env.BUILDER_PREVIEW_PORT ?? '')
      ? String(env.BUILDER_PREVIEW_PORT)
      : '',
    consoleOrigin: env.BUILDER_CONSOLE_ORIGIN ?? 'https://console.nuzm.test',
    previewTtlMinutes: n('BUILDER_PREVIEW_TTL_MINUTES', 30, 1),
    maxActivePreviews: n('BUILDER_MAX_ACTIVE_PREVIEWS', 10, 1),
    maxProjects: n('BUILDER_MAX_PROJECTS', 20, 1),
    formsBaseUrl: env.BUILDER_FORMS_BASE_URL ?? 'https://api.nuzm.test',
    dataRegion: env.AI_DATA_REGION ?? 'sa-central',
    projectRetentionDays: n('BUILDER_PROJECT_RETENTION_DAYS', 30, 1),
    formRatePerMinute: n('FORM_RATE_LIMIT_PER_MINUTE', 5, 1),
    formMaxBytes: n('FORM_MAX_BYTES', 16_384, 256),
    formRetentionDays: n('FORM_RETENTION_DAYS', 90, 1),
    ipHashSalt: env.FORM_IP_HASH_SALT ?? 'dev-only-salt-change-me',
  };
}
export const previewHost = (token: string, c: BuilderConfig) => `${token}.${c.previewDomain}`;
/** The address the console frames: `<scheme>://<token>.<previewDomain>[:port]/<locale>/`. */
export const previewUrl = (token: string, locale: string, c: BuilderConfig) =>
  `${c.previewScheme}://${previewHost(token, c)}${c.previewPort ? `:${c.previewPort}` : ''}/${locale}/`;
