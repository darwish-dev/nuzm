import { validateSchema, type Schema } from '@nuzm/domain';

/**
 * The structured MOBILE SPEC the design agent returns (S48.2: "screens -> widgets"). Model output is data: it is validated here and rendered to Dart by the trusted,
 * deterministic template renderer (`templates.ts`). A model never writes Dart that is compiled without passing through that renderer; every string is escaped there.
 */
export const SCREEN_KINDS = ['home', 'list', 'form', 'detail', 'settings'] as const;
export const FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'number',
  'password',
  'multiline',
  'choice',
  'switch',
] as const;
/** declared Android permissions (iOS usage strings are a release-checklist item); `internet` is the only default */
export const PERMISSIONS = ['internet', 'camera', 'location', 'notifications', 'photos'] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];
export type FieldType = (typeof FIELD_TYPES)[number];
export type Permission = (typeof PERMISSIONS)[number];
export interface Bilingual {
  ar: string;
  en: string;
}
export interface FieldSpec {
  id: string;
  label: Bilingual;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: Bilingual }[];
}
export interface ScreenSpec {
  id: string;
  title: Bilingual;
  kind: ScreenKind;
  body?: Bilingual;
  fields?: FieldSpec[];
  items?: { title: Bilingual; subtitle?: Bilingual }[];
}
export interface MobileSpec {
  schemaVersion: 1;
  app: { name: Bilingual; packageId: string; description?: Bilingual };
  theme: { primary: string; secondary?: string; dark: boolean };
  defaultLocale: 'ar' | 'en';
  auth: { enabled: boolean };
  screens: ScreenSpec[];
  navigation: { initial: string; tabs: string[] };
  permissions: Permission[];
}

const ID = '^[a-z][a-z0-9_]{0,30}$';
const bi = (max = 120): Schema => ({
  type: 'object',
  required: ['ar', 'en'],
  additionalProperties: false,
  properties: {
    ar: { type: 'string', minLength: 1, maxLength: max },
    en: { type: 'string', minLength: 1, maxLength: max },
  },
});
export const MOBILE_SPEC_SCHEMA: Schema = {
  type: 'object',
  required: ['schemaVersion', 'app', 'theme', 'defaultLocale', 'auth', 'screens', 'navigation', 'permissions'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    app: {
      type: 'object',
      required: ['name', 'packageId'],
      additionalProperties: false,
      properties: {
        name: bi(40),
        packageId: { type: 'string', pattern: '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*){2,4}$', maxLength: 80 },
        description: bi(300),
      },
    },
    theme: {
      type: 'object',
      required: ['primary', 'dark'],
      additionalProperties: false,
      properties: {
        primary: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        secondary: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        dark: { type: 'boolean' },
      },
    },
    defaultLocale: { enum: ['ar', 'en'] },
    auth: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
    screens: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['id', 'title', 'kind'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: ID },
          title: bi(60),
          kind: { enum: SCREEN_KINDS },
          body: bi(400),
          fields: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              required: ['id', 'label', 'type'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', pattern: ID },
                label: bi(60),
                type: { enum: FIELD_TYPES },
                required: { type: 'boolean' },
                options: {
                  type: 'array',
                  maxItems: 12,
                  items: {
                    type: 'object',
                    required: ['value', 'label'],
                    additionalProperties: false,
                    properties: { value: { type: 'string', pattern: ID }, label: bi(60) },
                  },
                },
              },
            },
          },
          items: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              required: ['title'],
              additionalProperties: false,
              properties: { title: bi(80), subtitle: bi(120) },
            },
          },
        },
      },
    },
    navigation: {
      type: 'object',
      required: ['initial', 'tabs'],
      additionalProperties: false,
      properties: {
        initial: { type: 'string', pattern: ID },
        tabs: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', pattern: ID } },
      },
    },
    permissions: { type: 'array', maxItems: 5, items: { enum: PERMISSIONS } },
  },
};

// control characters and bidi overrides never belong in an app string (the second set can reorder displayed text)
// eslint-disable-next-line no-control-regex
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const RESERVED = new Set(['login', 'splash', 'app', 'main', 'routes']);
const DART_KEYWORDS = new Set(['class', 'enum', 'new', 'null', 'this', 'true', 'false', 'var', 'void', 'with']);

/** Schema + semantic checks; returns messages ([] = valid). */
export function validateMobileSpec(spec: unknown): string[] {
  const errs = validateSchema(MOBILE_SPEC_SCHEMA, spec).map((e) => `${e.path} ${e.message}`);
  if (errs.length) return errs;
  const s = spec as MobileSpec;
  const out: string[] = [];
  const ids = s.screens.map((x) => x.id);
  if (new Set(ids).size !== ids.length) out.push('screen ids must be unique');
  for (const id of ids) if (RESERVED.has(id) || DART_KEYWORDS.has(id)) out.push(`screen id ${id} is reserved`);
  if (!ids.includes(s.navigation.initial)) out.push('navigation.initial is not a screen');
  for (const t of s.navigation.tabs) if (!ids.includes(t)) out.push(`navigation tab ${t} is not a screen`);
  if (new Set(s.navigation.tabs).size !== s.navigation.tabs.length) out.push('navigation tabs must be unique');
  if (s.navigation.tabs.length < 1) out.push('navigation needs a tab');
  for (const sc of s.screens) {
    if (sc.kind === 'form' && (!sc.fields || sc.fields.length < 1)) out.push(`form screen ${sc.id} needs fields`);
    if (sc.kind !== 'form' && sc.fields && sc.fields.length) out.push(`screen ${sc.id}: only form screens have fields`);
    if (sc.kind !== 'list' && sc.items && sc.items.length) out.push(`screen ${sc.id}: only list screens have items`);
    const fids = (sc.fields ?? []).map((f) => f.id);
    if (new Set(fids).size !== fids.length) out.push(`screen ${sc.id}: field ids must be unique`);
    for (const f of sc.fields ?? []) {
      if (f.type === 'choice' && (!f.options || f.options.length < 2)) out.push(`field ${sc.id}.${f.id}: a choice needs 2+ options`);
      if (f.type !== 'choice' && f.options?.length) out.push(`field ${sc.id}.${f.id}: only a choice has options`);
    }
  }
  if (new Set(s.permissions).size !== s.permissions.length) out.push('permissions must be unique');
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as object).forEach(walk);
  };
  walk(s);
  if (texts.some((t) => BAD_TEXT.test(t))) out.push('text contains control or bidi-override characters');
  return out;
}
