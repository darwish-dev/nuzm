import type { InstructionLayer } from './instructions';
import type { SkillProjectProfile } from './skill-resolver';

/**
 * AI Studio: what Nuzm itself contributes to every project — the platform baseline instructions, the framework layer of each
 * project type, and the Nuzm-owned starter skills. Customers edit only the project and customer layers; these come from code so
 * an improvement reaches every project on its next regeneration.
 */
export type StudioProjectType = 'website' | 'webapp' | 'mobile';

/** The stack a project of this type is generated with (M09 renderer, M10A web app, M10B Flutter). */
export function projectProfile(
  type: StudioProjectType,
  extra: Partial<SkillProjectProfile> = {},
): SkillProjectProfile {
  const base: Record<StudioProjectType, Pick<SkillProjectProfile, 'frameworks' | 'languages'>> = {
    website: { frameworks: ['html', 'tailwind'], languages: ['html', 'css'] },
    webapp: { frameworks: ['next.js', 'react', 'nestjs', 'postgresql'], languages: ['typescript'] },
    mobile: { frameworks: ['flutter'], languages: ['dart'] },
  };
  return { ...base[type], ...extra };
}

const PLATFORM: InstructionLayer = {
  source: 'platform',
  sections: [
    {
      id: 'workflow',
      title: 'Development workflow',
      rules: [
        {
          key: 'wf.inspect',
          text: 'Inspect the existing code before changing it and reuse what is there',
          strength: 'must',
        },
        { key: 'wf.small', text: 'Prefer small, incremental changes', strength: 'should' },
        { key: 'wf.tests', text: 'Run the relevant tests after each change', strength: 'must' },
        { key: 'wf.unrelated', text: 'Modify modules unrelated to the task', strength: 'never' },
      ],
    },
    {
      id: 'security',
      title: 'Security',
      rules: [
        {
          key: 'sec.secrets',
          text: 'Commit secrets, keys or passwords to the repository',
          strength: 'never',
          security: true,
        },
        {
          key: 'sec.input',
          text: 'Validate every input that crosses a trust boundary',
          strength: 'must',
          security: true,
        },
        {
          key: 'sec.authz',
          text: 'Check authorization on every server-side operation',
          strength: 'must',
          security: true,
        },
        {
          key: 'sec.force_push',
          text: 'Force-push or rewrite shared Git history',
          strength: 'never',
          security: true,
        },
      ],
    },
    {
      id: 'ui',
      title: 'User interface',
      rules: [
        {
          key: 'ui.rtl',
          text: 'Keep layouts correct in right-to-left (Arabic) and left-to-right (English)',
          strength: 'must',
        },
        {
          key: 'ui.a11y',
          text: 'Keep every control keyboard-accessible with a visible focus state',
          strength: 'must',
        },
        {
          key: 'ui.responsive',
          text: 'Use responsive layouts that work from phone to desktop',
          strength: 'should',
        },
      ],
    },
  ],
};

const FRAMEWORK: Record<StudioProjectType, InstructionLayer> = {
  website: {
    source: 'framework',
    sections: [
      {
        id: 'stack',
        title: 'Technology stack',
        rules: [
          {
            key: 'stack.site',
            text: 'The site is rendered from the Nuzm site model to static HTML and Tailwind CSS',
            strength: 'must',
          },
          {
            key: 'stack.js',
            text: 'Add third-party scripts without an approved need',
            strength: 'never',
          },
        ],
      },
    ],
  },
  webapp: {
    source: 'framework',
    sections: [
      {
        id: 'stack',
        title: 'Technology stack',
        rules: [
          {
            key: 'stack.front',
            text: 'Frontend: Next.js (App Router) with TypeScript in strict mode',
            strength: 'must',
          },
          {
            key: 'stack.back',
            text: 'Backend: NestJS modules with validated DTOs',
            strength: 'must',
          },
          {
            key: 'stack.db',
            text: 'Database: PostgreSQL through migrations; never edit the schema by hand',
            strength: 'must',
          },
        ],
      },
      {
        id: 'backend',
        title: 'Backend rules',
        rules: [
          {
            key: 'be.tenant',
            text: 'Scope every query to the tenant of the signed-in user',
            strength: 'must',
            security: true,
          },
          { key: 'be.tests', text: 'Add tests for business logic', strength: 'must' },
        ],
      },
    ],
  },
  mobile: {
    source: 'framework',
    sections: [
      {
        id: 'stack',
        title: 'Technology stack',
        rules: [
          {
            key: 'stack.flutter',
            text: 'Flutter with null-safe Dart; keep business logic out of widgets',
            strength: 'must',
          },
          {
            key: 'stack.l10n',
            text: 'Put every user-visible string in the localization files (ar and en)',
            strength: 'must',
          },
        ],
      },
    ],
  },
};

/** The layers Nuzm owns for a project of this type, lowest precedence first. */
export function baselineInstructionLayers(type: StudioProjectType): InstructionLayer[] {
  return [PLATFORM, FRAMEWORK[type]];
}

export interface BuiltinSkill {
  slug: string;
  description: string;
  category: string;
  scope: 'global' | 'framework' | 'language' | 'industry';
  frameworks: string[];
  languages: string[];
  industries: string[];
  requires: string[];
  body: string;
}
const skill = (
  s: Omit<BuiltinSkill, 'frameworks' | 'languages' | 'industries' | 'requires'> &
    Partial<BuiltinSkill>,
): BuiltinSkill => ({
  frameworks: [],
  languages: [],
  industries: [],
  requires: [],
  ...s,
});

/** Nuzm-owned starter skills (source `nuzm`): plain instructions, no scripts, scanned at bootstrap like any other skill. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  skill({
    slug: 'nuzm-architecture',
    description:
      'Keeps changes modular: reuse existing modules, no duplicated business logic, clear boundaries.',
    category: 'architecture',
    scope: 'global',
    body: '# Architecture\n\n- Read the module you are changing and its public entry point first.\n- Put new logic next to the code it belongs to; do not duplicate business rules.\n- Keep modules talking through their public interfaces only.\n',
  }),
  skill({
    slug: 'nuzm-code-quality',
    description:
      'Code quality defaults: strict types, small functions, meaningful names, no dead code.',
    category: 'code-quality',
    scope: 'global',
    body: '# Code quality\n\n- Keep types strict; avoid `any`.\n- Name things for what they mean in the business.\n- Remove code you replace instead of commenting it out.\n',
  }),
  skill({
    slug: 'nuzm-testing',
    description:
      'Testing workflow: write or update tests with every behaviour change and run them before finishing.',
    category: 'testing',
    scope: 'global',
    body: '# Testing\n\n- Add a test for every behaviour you add or change.\n- Run the affected tests before you finish and report the result honestly.\n',
  }),
  skill({
    slug: 'nuzm-security',
    description:
      'Security checklist: input validation, authorization on every operation, no secrets in code.',
    category: 'security',
    scope: 'global',
    body: '# Security\n\n- Validate input at every trust boundary.\n- Check authorization on the server for every operation.\n- Keep secrets out of code, logs and commits.\n',
  }),
  skill({
    slug: 'nuzm-rtl-ui',
    description:
      'Bilingual Arabic/English UI: logical CSS properties, mirrored icons, locale-aware numbers and dates.',
    category: 'design',
    scope: 'global',
    body: '# Right-to-left UI\n\n- Use logical properties (margin-inline-start, inset-inline-end) instead of left/right.\n- Mirror directional icons in RTL.\n- Format numbers and dates with the user locale.\n',
  }),
  skill({
    slug: 'nuzm-nextjs',
    description:
      'Next.js App Router conventions: server components by default, typed routes, loading and error states.',
    category: 'frontend',
    scope: 'framework',
    frameworks: ['next.js'],
    requires: ['nuzm-code-quality'],
    body: '# Next.js\n\n- Default to server components; mark client components explicitly.\n- Give every route loading, empty and error states.\n',
  }),
  skill({
    slug: 'nuzm-nestjs',
    description:
      'NestJS backend conventions: modules, validated DTOs, guards for authorization, migrations for schema.',
    category: 'backend',
    scope: 'framework',
    frameworks: ['nestjs'],
    requires: ['nuzm-security'],
    body: '# NestJS\n\n- One module per business area; export only what others need.\n- Validate every DTO and authorize every route with a guard.\n',
  }),
  skill({
    slug: 'nuzm-flutter',
    description:
      'Flutter conventions: null-safe Dart, state outside widgets, localized strings in ar and en.',
    category: 'mobile',
    scope: 'framework',
    frameworks: ['flutter'],
    body: '# Flutter\n\n- Keep state and business logic outside widgets.\n- Put every visible string in the ar and en localization files.\n',
  }),
];

/** The `SKILL.md` text of a built-in skill (front matter + body), exactly as installed into `.claude/skills/<slug>/`. */
export function builtinSkillMarkdown(s: BuiltinSkill): string {
  const list = (k: string, v: string[]) => (v.length ? `${k}: [${v.join(', ')}]\n` : '');
  return (
    `---\nname: ${s.slug}\ndescription: ${s.description}\ncategory: ${s.category}\n` +
    list('frameworks', s.frameworks) +
    list('languages', s.languages) +
    list('industries', s.industries) +
    list('requires', s.requires) +
    `version: 1.0.0\nlicense: Proprietary\n---\n${s.body}`
  );
}
