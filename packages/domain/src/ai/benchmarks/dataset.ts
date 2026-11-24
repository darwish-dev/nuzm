import { APP_TASKS } from './dataset-apps';
import { ENGINEERING_TASKS } from './dataset-engineering';
import { WEB_TASKS } from './dataset-web';
import { json, task } from './task-builder';
import type { FixtureFile, GoldenTask } from './types';

/**
 * The golden task suite (S-AG5, offline): 24 synthetic tasks, 6 per kind, Arabic and English prompts. Authored for this suite; no customer data, no template content,
 * data class `public`. Each task carries its REFERENCE solution, which proves its checks can be satisfied and that an empty proposal fails them (see the spec).
 */
const SITE = (extra = ''): FixtureFile[] => [
  {
    path: 'content/site.json',
    content: `{"title":"Oasis Cafe","pages":[{"slug":"home","hero":{"heading":"Welcome"},"sections":[]}]${extra}}\n`,
  },
  { path: 'content/tokens.json', content: '{"accent":"#B45309","radius":"md"}\n' },
];
const APP: FixtureFile[] = [
  { path: 'package.json', content: '{"name":"demo","scripts":{"build":"next build"}}\n' },
  {
    path: 'src/app/page.tsx',
    content: 'export default function Home() { return <main>Home</main>; }\n',
  },
  { path: 'src/lib/format.ts', content: 'export const pad = (n: number) => String(n);\n' },
];
const LIB: FixtureFile[] = [
  {
    path: 'src/range.ts',
    content:
      'export function range(n: number) {\n  const out: number[] = [];\n  for (let i = 0; i <= n; i++) out.push(i);\n  return out;\n}\n',
  },
  { path: 'src/consts.ts', content: 'export const MAX_ITEMS = 10;\n' },
  { path: 'src/unused.ts', content: 'export const legacy = () => 0;\n' },
];

/** The original 24 tasks (S-AG5 offline baseline). Their prompts, fixtures, checks and solutions are unchanged; they gained a category. */
export const CORE_TASKS: readonly GoldenTask[] = [
  // ---- website (6)
  task({
    id: 'web-01-hero-en',
    kind: 'website',
    locale: 'en',
    title: 'Change the hero heading',
    prompt: 'Change the home page heading to "Fresh coffee every morning".',
    fixture: SITE(),
    checks: [
      { type: 'json_valid', path: 'content/site.json' },
      { type: 'contains', path: 'content/site.json', text: 'Fresh coffee every morning' },
      { type: 'not_contains', path: 'content/site.json', text: '"Welcome"' },
    ],
    solution: [
      {
        path: 'content/site.json',
        content: json({
          title: 'Oasis Cafe',
          pages: [{ slug: 'home', hero: { heading: 'Fresh coffee every morning' }, sections: [] }],
        }),
      },
    ],
  }),
  task({
    id: 'web-02-hero-ar',
    kind: 'website',
    locale: 'ar',
    title: 'تغيير عنوان الصفحة الرئيسية',
    prompt: 'غيّر عنوان الصفحة الرئيسية إلى "قهوة طازجة كل صباح".',
    fixture: SITE(),
    checks: [
      { type: 'json_valid', path: 'content/site.json' },
      { type: 'contains', path: 'content/site.json', text: 'قهوة طازجة كل صباح' },
    ],
    solution: [
      {
        path: 'content/site.json',
        content: json({
          title: 'Oasis Cafe',
          pages: [{ slug: 'home', hero: { heading: 'قهوة طازجة كل صباح' }, sections: [] }],
        }),
      },
    ],
  }),
  task({
    id: 'web-03-about-page',
    kind: 'website',
    locale: 'en',
    title: 'Add an About page',
    prompt: 'Add an About page with a short paragraph about the cafe.',
    fixture: SITE(),
    checks: [
      { type: 'json_valid', path: 'content/site.json' },
      { type: 'contains', path: 'content/site.json', text: '"slug":"about"' },
    ],
    solution: [
      {
        path: 'content/site.json',
        content: json({
          title: 'Oasis Cafe',
          pages: [
            { slug: 'home', hero: { heading: 'Welcome' }, sections: [] },
            {
              slug: 'about',
              hero: { heading: 'About us' },
              sections: [{ type: 'text', body: 'A small cafe.' }],
            },
          ],
        }),
      },
    ],
  }),
  task({
    id: 'web-04-accent-color',
    kind: 'website',
    locale: 'en',
    title: 'Change the accent colour',
    prompt: 'Make the accent colour a deep green, #166534.',
    fixture: SITE(),
    checks: [
      { type: 'json_valid', path: 'content/tokens.json' },
      { type: 'contains', path: 'content/tokens.json', text: '#166534' },
      { type: 'not_contains', path: 'content/tokens.json', text: '#B45309' },
    ],
    solution: [{ path: 'content/tokens.json', content: json({ accent: '#166534', radius: 'md' }) }],
  }),
  task({
    id: 'web-05-contact-section',
    kind: 'website',
    locale: 'ar',
    title: 'إضافة نموذج تواصل',
    prompt: 'أضف قسم نموذج تواصل في الصفحة الرئيسية.',
    fixture: SITE(),
    checks: [
      { type: 'json_valid', path: 'content/site.json' },
      { type: 'contains', path: 'content/site.json', text: 'contact_form' },
    ],
    solution: [
      {
        path: 'content/site.json',
        content: json({
          title: 'Oasis Cafe',
          pages: [
            { slug: 'home', hero: { heading: 'Welcome' }, sections: [{ type: 'contact_form' }] },
          ],
        }),
      },
    ],
  }),
  task({
    id: 'web-06-seo-title',
    kind: 'website',
    locale: 'en',
    title: 'Set the site title',
    prompt: 'Rename the site to "Oasis Coffee House".',
    fixture: SITE(),
    checks: [
      { type: 'json_valid', path: 'content/site.json' },
      { type: 'contains', path: 'content/site.json', text: 'Oasis Coffee House' },
    ],
    solution: [
      {
        path: 'content/site.json',
        content: json({
          title: 'Oasis Coffee House',
          pages: [{ slug: 'home', hero: { heading: 'Welcome' }, sections: [] }],
        }),
      },
    ],
  }),
  // ---- webapp (6)
  task({
    id: 'app-01-about-route',
    kind: 'webapp',
    locale: 'en',
    title: 'Add a route',
    prompt: 'Add an /about page that says "About".',
    fixture: APP,
    checks: [
      { type: 'file_exists', path: 'src/app/about/page.tsx' },
      { type: 'contains', path: 'src/app/about/page.tsx', text: 'About' },
    ],
    solution: [
      {
        path: 'src/app/about/page.tsx',
        content: 'export default function About() { return <main>About</main>; }\n',
      },
    ],
  }),
  task({
    id: 'app-02-health-api',
    kind: 'webapp',
    locale: 'en',
    title: 'Add a health endpoint',
    prompt: 'Add an API route /api/health that returns {"ok":true}.',
    fixture: APP,
    checks: [
      { type: 'file_exists', path: 'src/app/api/health/route.ts' },
      { type: 'contains', path: 'src/app/api/health/route.ts', text: 'ok: true' },
    ],
    solution: [
      {
        path: 'src/app/api/health/route.ts',
        content: 'export async function GET() {\n  return Response.json({ ok: true });\n}\n',
      },
    ],
  }),
  task({
    id: 'app-03-home-title',
    kind: 'webapp',
    locale: 'ar',
    title: 'تغيير نص الصفحة الرئيسية',
    prompt: 'غيّر نص الصفحة الرئيسية إلى "أهلاً بكم".',
    fixture: APP,
    checks: [
      { type: 'contains', path: 'src/app/page.tsx', text: 'أهلاً بكم' },
      { type: 'not_contains', path: 'src/app/page.tsx', text: '>Home<' },
    ],
    solution: [
      {
        path: 'src/app/page.tsx',
        content: 'export default function Home() { return <main>أهلاً بكم</main>; }\n',
      },
    ],
  }),
  task({
    id: 'app-04-pad-helper',
    kind: 'webapp',
    locale: 'en',
    title: 'Improve a helper',
    prompt: 'Make `pad` zero-pad numbers to two digits.',
    fixture: APP,
    checks: [{ type: 'contains', path: 'src/lib/format.ts', text: "padStart(2, '0')" }],
    solution: [
      {
        path: 'src/lib/format.ts',
        content: "export const pad = (n: number) => String(n).padStart(2, '0');\n",
      },
    ],
    mustCall: ['read_file'],
  }),
  task({
    id: 'app-05-script',
    kind: 'webapp',
    locale: 'en',
    title: 'Add an npm script',
    prompt: 'Add a "lint" script to package.json that runs "next lint".',
    fixture: APP,
    checks: [
      { type: 'json_valid', path: 'package.json' },
      { type: 'contains', path: 'package.json', text: '"lint":"next lint"' },
    ],
    solution: [
      {
        path: 'package.json',
        content: json({ name: 'demo', scripts: { build: 'next build', lint: 'next lint' } }),
      },
    ],
  }),
  task({
    id: 'app-06-component',
    kind: 'webapp',
    locale: 'en',
    title: 'Add a component',
    prompt:
      'Add a Badge component in src/components/Badge.tsx that renders its children in a span.',
    fixture: APP,
    checks: [
      { type: 'file_exists', path: 'src/components/Badge.tsx' },
      { type: 'contains', path: 'src/components/Badge.tsx', text: '<span' },
    ],
    solution: [
      {
        path: 'src/components/Badge.tsx',
        content:
          'export function Badge({ children }: { children: React.ReactNode }) {\n  return <span>{children}</span>;\n}\n',
      },
    ],
  }),
  // ---- code-edit (6)
  task({
    id: 'code-01-off-by-one',
    kind: 'code-edit',
    category: 'bug-fixing',
    locale: 'en',
    title: 'Fix an off-by-one',
    prompt: 'range(n) should return n numbers, 0 to n-1. Fix it.',
    fixture: LIB,
    checks: [
      { type: 'contains', path: 'src/range.ts', text: 'i < n' },
      { type: 'not_contains', path: 'src/range.ts', text: 'i <= n' },
    ],
    solution: [
      {
        path: 'src/range.ts',
        content:
          'export function range(n: number) {\n  const out: number[] = [];\n  for (let i = 0; i < n; i++) out.push(i);\n  return out;\n}\n',
      },
    ],
    mustCall: ['read_file'],
  }),
  task({
    id: 'code-02-constant',
    kind: 'code-edit',
    locale: 'en',
    title: 'Change a constant',
    prompt: 'Raise MAX_ITEMS to 25.',
    fixture: LIB,
    checks: [
      { type: 'contains', path: 'src/consts.ts', text: 'MAX_ITEMS = 25' },
      { type: 'not_contains', path: 'src/consts.ts', text: 'MAX_ITEMS = 10' },
    ],
    solution: [{ path: 'src/consts.ts', content: 'export const MAX_ITEMS = 25;\n' }],
  }),
  task({
    id: 'code-03-remove-dead',
    kind: 'code-edit',
    locale: 'en',
    title: 'Remove dead code',
    prompt: 'Delete the unused file src/unused.ts.',
    fixture: LIB,
    checks: [{ type: 'file_absent', path: 'src/unused.ts' }],
    solution: [{ path: 'src/unused.ts', content: null }],
    mustCall: ['search_code'],
  }),
  task({
    id: 'code-04-add-function',
    kind: 'code-edit',
    locale: 'ar',
    title: 'إضافة دالة',
    prompt: 'أضف دالة sum في src/sum.ts تجمع مصفوفة أرقام.',
    fixture: LIB,
    checks: [
      { type: 'file_exists', path: 'src/sum.ts' },
      { type: 'contains', path: 'src/sum.ts', text: 'export function sum' },
    ],
    solution: [
      {
        path: 'src/sum.ts',
        content:
          'export function sum(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n',
      },
    ],
  }),
  task({
    id: 'code-05-rename',
    kind: 'code-edit',
    locale: 'en',
    title: 'Rename a function',
    prompt: 'Rename `range` to `countTo` in src/range.ts.',
    fixture: LIB,
    checks: [
      { type: 'contains', path: 'src/range.ts', text: 'function countTo' },
      { type: 'not_contains', path: 'src/range.ts', text: 'function range' },
    ],
    solution: [
      {
        path: 'src/range.ts',
        content:
          'export function countTo(n: number) {\n  const out: number[] = [];\n  for (let i = 0; i <= n; i++) out.push(i);\n  return out;\n}\n',
      },
    ],
    mustCall: ['read_file', 'search_code'],
  }),
  task({
    id: 'code-06-type',
    kind: 'code-edit',
    locale: 'en',
    title: 'Add a type',
    prompt: 'Add an exported type Item = { id: string; name: string } in src/types.ts.',
    fixture: LIB,
    checks: [
      { type: 'file_exists', path: 'src/types.ts' },
      { type: 'contains', path: 'src/types.ts', text: 'export type Item' },
    ],
    solution: [
      { path: 'src/types.ts', content: 'export type Item = { id: string; name: string };\n' },
    ],
  }),
  // ---- tool-calling (6): the answer depends on exploring first
  ...(
    [
      [
        'tool-01-find-constant',
        'en',
        'Find and change a constant',
        'Somewhere in the project a limit of 10 items is defined. Find it and make it 20.',
        ['search_code', 'read_file'],
        'src/consts.ts',
        'export const MAX_ITEMS = 20;\n',
        'MAX_ITEMS = 20',
      ],
      [
        'tool-02-inspect-first',
        'en',
        'Inspect before editing',
        'Look at how the project is structured, then add a file src/README.md that lists its folders.',
        ['inspect_project'],
        'src/README.md',
        '# src\n\nFiles: range, consts, unused.\n',
        'Files:',
      ],
      [
        'tool-03-list-and-read',
        'ar',
        'استكشاف ثم تعديل',
        'اقرأ ملف الثوابت ثم أضف ثابتًا اسمه MIN_ITEMS بقيمة 1.',
        ['list_files', 'read_file'],
        'src/consts.ts',
        'export const MAX_ITEMS = 10;\nexport const MIN_ITEMS = 1;\n',
        'MIN_ITEMS = 1',
      ],
      [
        'tool-04-search-usage',
        'en',
        'Check usage before deleting',
        'Delete src/unused.ts only after checking that nothing imports it.',
        ['search_code'],
        'src/unused.ts',
        null,
        '',
      ],
      [
        'tool-05-read-range',
        'en',
        'Read a part of a file',
        'Read the first lines of src/range.ts and add a comment above the function saying what it does.',
        ['read_file'],
        'src/range.ts',
        '// Returns the numbers from 0 to n.\nexport function range(n: number) {\n  const out: number[] = [];\n  for (let i = 0; i <= n; i++) out.push(i);\n  return out;\n}\n',
        'Returns the numbers',
      ],
      [
        'tool-06-list-dir',
        'en',
        'List a folder',
        'List the files in src and add an index.ts that re-exports consts.',
        ['list_files'],
        'src/index.ts',
        "export * from './consts';\n",
        "export * from './consts'",
      ],
    ] as const
  ).map(([id, locale, title, prompt, mustCall, path, content, needle]) =>
    task({
      id,
      kind: 'tool-calling',
      locale,
      title,
      prompt,
      fixture: LIB,
      checks:
        content === null
          ? [{ type: 'file_absent', path }]
          : [
              { type: 'file_exists', path },
              { type: 'contains', path, text: needle },
            ],
      solution: [{ path, content }],
      mustCall: [...mustCall],
    }),
  ),
];

/** The full suite: the 24 original tasks plus the extended tasks that cover every one of the 23 categories. */
export const GOLDEN_TASKS: readonly GoldenTask[] = [
  ...CORE_TASKS,
  ...WEB_TASKS,
  ...APP_TASKS,
  ...ENGINEERING_TASKS,
];
