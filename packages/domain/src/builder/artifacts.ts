import type { Schema } from '../schema';
import { LOCALES, SECTION_TYPES, type Localized, type Locale, type Tokens } from './site-model';

/**
 * Artifacts of the website agents (M09 S38/S39): validated JSON that a run stores in `ai.artifacts`. They are data, never code. Every agent output is checked against
 * these schemas (repair loop ≤ 2, then the run fails); nothing a model returns is executed.
 */
export const BUSINESS_TYPES = [
  'restaurant',
  'clinic',
  'retail',
  'portfolio',
  'services',
  'education',
  'ngo',
  'landing',
  'other',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const PAGE_KINDS = [
  'home',
  'about',
  'services',
  'menu',
  'products',
  'gallery',
  'pricing',
  'faq',
  'contact',
  'team',
  'programs',
  'projects',
] as const;
export const TONES = ['formal', 'friendly', 'playful', 'premium', 'minimal'] as const;
export const INTEGRATIONS = ['contact_form', 'map', 'whatsapp_link'] as const;
export const MAX_QUESTIONS = 12; // PROPOSAL (owner to confirm)

export interface Requirements {
  businessType: BusinessType;
  businessName: string;
  description: string;
  audiences: string[];
  languages: Locale[];
  pages: (typeof PAGE_KINDS)[number][];
  tone: (typeof TONES)[number];
  brandColors?: { primary?: string; accent?: string };
  wantsLogo: boolean;
  contact: { phone?: string; email?: string; address?: string; hours?: string[] };
  integrations: (typeof INTEGRATIONS)[number][];
  domainWishes: string[];
  templateId?: string;
  /** true when the user skipped the questions and defaults were applied */
  usedDefaults: boolean;
  questionsAnswered: number;
}
const HEX = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';
const strs = (max: number, items: number): Schema => ({
  type: 'array',
  maxItems: items,
  items: { type: 'string', minLength: 1, maxLength: max },
});
export const REQUIREMENTS_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'businessType',
    'businessName',
    'description',
    'audiences',
    'languages',
    'pages',
    'tone',
    'wantsLogo',
    'contact',
    'integrations',
    'domainWishes',
    'usedDefaults',
    'questionsAnswered',
  ],
  properties: {
    businessType: { enum: BUSINESS_TYPES },
    businessName: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', minLength: 1, maxLength: 600 },
    audiences: strs(80, 5),
    languages: { type: 'array', minItems: 1, maxItems: 2, items: { enum: LOCALES } },
    pages: { type: 'array', minItems: 1, maxItems: 8, items: { enum: PAGE_KINDS } },
    tone: { enum: TONES },
    brandColors: {
      type: 'object',
      additionalProperties: false,
      properties: {
        primary: { type: 'string', pattern: HEX },
        accent: { type: 'string', pattern: HEX },
      },
    },
    wantsLogo: { type: 'boolean' },
    contact: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phone: { type: 'string', maxLength: 24 },
        email: { type: 'string', maxLength: 200 },
        address: { type: 'string', maxLength: 200 },
        hours: strs(60, 14),
      },
    },
    integrations: { type: 'array', maxItems: 3, items: { enum: INTEGRATIONS } },
    domainWishes: strs(100, 3),
    templateId: { type: 'string', maxLength: 40 },
    usedDefaults: { type: 'boolean' },
    questionsAnswered: { type: 'integer', minimum: 0, maximum: MAX_QUESTIONS },
  },
};

/** One turn of the requirements conversation: either more questions, or the final requirements. */
export interface RequirementsTurn {
  /** present while the agent still needs answers (max `MAX_QUESTIONS` in total over the conversation) */
  questions?: { id: string; text: Localized; choices?: string[] }[];
  requirements?: Requirements;
}
export const REQUIREMENTS_TURN_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,29}$' },
          text: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ar: { type: 'string', maxLength: 300 },
              en: { type: 'string', maxLength: 300 },
            },
          },
          choices: strs(60, 8),
        },
      },
    },
    requirements: REQUIREMENTS_SCHEMA,
  },
};

export interface ArchitecturePage {
  pageId: string;
  slug: string;
  title: Localized;
  purpose: string;
  sections: { type: (typeof SECTION_TYPES)[number]; intent: string }[];
}
export interface Architecture {
  siteMap: ArchitecturePage[];
  designTokens: Tokens & {
    colors: { primary: string; accent: string; background: string; text: string };
  };
  seoPlan: { pageId: string; title: Localized; description: Localized; keywords: string[] }[];
  templateId?: string;
}
const L = (max: number): Schema => ({
  type: 'object',
  additionalProperties: false,
  properties: { ar: { type: 'string', maxLength: max }, en: { type: 'string', maxLength: max } },
});
export const ARCHITECTURE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['siteMap', 'designTokens', 'seoPlan'],
  properties: {
    siteMap: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pageId', 'slug', 'title', 'purpose', 'sections'],
        properties: {
          pageId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' },
          slug: { type: 'string', pattern: '^(home|[a-z0-9][a-z0-9-]{0,59})$' },
          title: L(80),
          purpose: { type: 'string', maxLength: 300 },
          sections: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'intent'],
              properties: {
                type: { enum: SECTION_TYPES },
                intent: { type: 'string', maxLength: 200 },
              },
            },
          },
        },
      },
    },
    designTokens: {
      type: 'object',
      additionalProperties: false,
      required: ['radius', 'spacing', 'fontFamily', 'width', 'colors'],
      properties: {
        radius: { enum: ['none', 'sm', 'md', 'lg'] },
        spacing: { enum: ['compact', 'normal', 'relaxed'] },
        fontFamily: { enum: ['sans', 'serif'] },
        width: { enum: ['narrow', 'normal', 'wide'] },
        colors: {
          type: 'object',
          additionalProperties: false,
          required: ['primary', 'accent', 'background', 'text'],
          properties: {
            primary: { type: 'string', pattern: HEX },
            accent: { type: 'string', pattern: HEX },
            background: { type: 'string', pattern: HEX },
            text: { type: 'string', pattern: HEX },
          },
        },
      },
    },
    seoPlan: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pageId', 'title', 'description', 'keywords'],
        properties: {
          pageId: { type: 'string' },
          title: L(70),
          description: L(200),
          keywords: strs(40, 10),
        },
      },
    },
    templateId: { type: 'string', maxLength: 40 },
  },
};

/** The tool envelope every agent answer may carry. The engine checks `toolCalls` against the allow-list of the run kind and EXECUTES NONE of them in v1. */
export interface AgentEnvelope<T> {
  result: T;
  toolCalls?: { name: string; args?: unknown }[];
}
export const envelopeSchema = (result: Schema): Schema => ({
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result,
    toolCalls: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', maxLength: 80 }, args: {} },
      },
    },
  },
});

/** Output of the per-page copy/layout step (S39): one page of the site model. */
export const PAGE_RESULT_SCHEMA: Schema = {
  type: 'object',
  required: ['pageId', 'title', 'sections'],
  properties: {
    pageId: { type: 'string' },
    title: L(80),
    seo: { type: 'object' },
    sections: {
      type: 'array',
      maxItems: 40,
      // every section carries its own id, a known type and a props object: a real model cannot guess this, and the assembler needs it
      items: {
        type: 'object',
        required: ['id', 'type', 'props'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' },
          type: { enum: SECTION_TYPES },
          props: { type: 'object' },
        },
      },
    },
  },
};
