import type { ErrorClass } from './classes';

/**
 * The offline repair corpus (P3-S03): small synthetic projects that fail in one well-known way each. Every case is DATA: the broken project, the classes its first failure must show,
 * and `modelReply`, the answer a scripted stand-in model gives when the engine asks (a developer-written fix: it measures the engine around a model, never a model). A case that the
 * deterministic fixers solve has no `modelReply` and must be green without any model turn.
 *
 * The projects are generated, never customer data. The verifier that decides "green" is chosen by the runner: the real TypeScript compiler (in memory) for `ts` cases, a static
 * predicate for the others (labelled as such in every result: nothing executes generated code here).
 */
export interface CorpusCase {
  id: string;
  title: string;
  /** `ts` cases are verified by the TypeScript compiler; the others by `check` (a static predicate, SIMULATED) */
  verifier: 'ts' | 'predicate';
  files: Record<string, string>;
  expectClasses: readonly ErrorClass[];
  /** true when the deterministic fixers must solve it without a model */
  deterministic: boolean;
  /** the scripted model's JSON proposal (when the engine has to ask a model) */
  modelReply?: {
    summary: string;
    patches: { op: 'modify' | 'add'; path: string; content: string }[];
  };
  /** for `predicate` cases: is the project fixed? */
  check?: (files: ReadonlyMap<string, string>) => boolean;
}

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"]
}
`;
const PKG = '{\n  "name": "fixture",\n  "private": true,\n  "version": "0.0.0"\n}\n';
const base = (more: Record<string, string>): Record<string, string> => ({
  'tsconfig.json': TSCONFIG,
  'package.json': PKG,
  ...more,
});

export const CORPUS: readonly CorpusCase[] = [
  {
    id: 'ts-type-mismatch',
    title: 'a string is assigned to a number',
    verifier: 'ts',
    files: base({
      'src/price.ts': `export function total(items: { price: number }[]): number {
  let sum = 0;
  for (const i of items) sum += i.price;
  return sum;
}
export const label: number = \`Total: \${total([])}\`;
`,
    }),
    expectClasses: ['type_mismatch'],
    deterministic: false,
    modelReply: {
      summary: 'the label is text: annotate it as a string',
      patches: [
        {
          op: 'modify',
          path: 'src/price.ts',
          content: `export function total(items: { price: number }[]): number {
  let sum = 0;
  for (const i of items) sum += i.price;
  return sum;
}
export const label: string = \`Total: \${total([])}\`;
`,
        },
      ],
    },
  },
  {
    id: 'ts-missing-import',
    title: 'a helper is used without importing it',
    verifier: 'ts',
    files: base({
      'src/format.ts':
        'export function formatMoney(minor: number): string {\n  return (minor / 100).toFixed(2);\n}\n',
      'src/cart.ts':
        'export function show(minor: number): string {\n  return formatMoney(minor);\n}\n',
    }),
    expectClasses: ['undefined_name'],
    deterministic: true,
  },
  {
    id: 'ts-wrong-relative-path',
    title: 'a relative import points at the wrong folder',
    verifier: 'ts',
    files: base({
      'src/lib/format.ts':
        'export function formatMoney(minor: number): string {\n  return (minor / 100).toFixed(2);\n}\n',
      'src/cart.ts':
        "import { formatMoney } from './helpers/format';\n\nexport const show = (minor: number): string => formatMoney(minor);\n",
    }),
    expectClasses: ['missing_module'],
    deterministic: true,
  },
  {
    id: 'ts-declared-not-exported',
    title: 'an import names a function the module declares but does not export',
    verifier: 'ts',
    files: base({
      'src/util.ts':
        "function slug(s: string): string {\n  return s.toLowerCase().replace(/\\s+/g, '-');\n}\nexport const id = 1;\n",
      'src/page.ts': "import { slug } from './util';\n\nexport const s = slug('A B');\n",
    }),
    expectClasses: ['missing_export'],
    deterministic: true,
  },
  {
    id: 'ts-unused-import',
    title: 'an import is never used (noUnusedLocals)',
    verifier: 'ts',
    files: base({
      'src/b.ts': 'export const helperB = 2;\n',
      'src/a.ts': "import { helperB } from './b';\n\nexport const a = 1;\n",
    }),
    expectClasses: ['unused_symbol'],
    deterministic: true,
  },
  {
    id: 'ts-call-signature',
    title: 'a function is called with too few arguments',
    verifier: 'ts',
    files: base({
      'src/shape.ts':
        'export function area(w: number, h: number): number {\n  return w * h;\n}\nexport const small = area(3);\n',
    }),
    expectClasses: ['call_signature'],
    deterministic: false,
    modelReply: {
      summary: 'pass both dimensions',
      patches: [
        {
          op: 'modify',
          path: 'src/shape.ts',
          content:
            'export function area(w: number, h: number): number {\n  return w * h;\n}\nexport const small = area(3, 3);\n',
        },
      ],
    },
  },
  {
    id: 'ts-possibly-undefined',
    title: 'a lookup result is used without handling the empty case',
    verifier: 'ts',
    files: base({
      'src/names.ts':
        'export function firstLong(a: string[]): string {\n  return a.find((x) => x.length > 2).toUpperCase();\n}\n',
    }),
    expectClasses: ['null_safety'],
    deterministic: false,
    modelReply: {
      summary: 'handle the case where nothing matches',
      patches: [
        {
          op: 'modify',
          path: 'src/names.ts',
          content:
            "export function firstLong(a: string[]): string {\n  return a.find((x) => x.length > 2)?.toUpperCase() ?? '';\n}\n",
        },
      ],
    },
  },
  {
    id: 'ts-missing-property',
    title: 'a property that the type does not declare is read',
    verifier: 'ts',
    files: base({
      'src/user.ts':
        "export interface User {\n  id: string;\n  name: string;\n}\nconst u: User = { id: '1', name: 'Ada' };\nexport const contact: string = u.email;\n",
    }),
    expectClasses: ['missing_property'],
    deterministic: false,
    modelReply: {
      summary: 'read the declared property',
      patches: [
        {
          op: 'modify',
          path: 'src/user.ts',
          content:
            "export interface User {\n  id: string;\n  name: string;\n}\nconst u: User = { id: '1', name: 'Ada' };\nexport const contact: string = u.name;\n",
        },
      ],
    },
  },
  {
    id: 'ts-syntax-error',
    title: 'an array literal is not closed',
    verifier: 'ts',
    files: base({
      'src/list.ts': 'export const nums = [1, 2, 3;\nexport const count = nums.length;\n',
    }),
    expectClasses: ['syntax_error'],
    deterministic: false,
    modelReply: {
      summary: 'close the array',
      patches: [
        {
          op: 'modify',
          path: 'src/list.ts',
          content: 'export const nums = [1, 2, 3];\nexport const count = nums.length;\n',
        },
      ],
    },
  },
  {
    id: 'ts-two-classes',
    title: 'a missing import and a type error in different files',
    verifier: 'ts',
    files: base({
      'src/format.ts':
        'export function formatMoney(minor: number): string {\n  return (minor / 100).toFixed(2);\n}\n',
      'src/cart.ts':
        'export function show(minor: number): string {\n  return formatMoney(minor);\n}\n',
      'src/count.ts': "export const items: number = 'three';\n",
    }),
    expectClasses: ['undefined_name', 'type_mismatch'],
    deterministic: false,
    modelReply: {
      summary: 'the count is a number',
      patches: [
        { op: 'modify', path: 'src/count.ts', content: 'export const items: number = 3;\n' },
      ],
    },
  },
  {
    id: 'test-assertion',
    title: 'a test expects the discounted price',
    verifier: 'predicate',
    files: {
      'package.json': PKG,
      'src/discount.ts':
        'export function applyDiscount(price: number, percent: number): number {\n  return price - percent;\n}\n',
      'src/discount.test.ts':
        "import { applyDiscount } from './discount';\n\ntest('applies a percentage discount', () => {\n  expect(applyDiscount(100, 10)).toBe(90);\n  expect(applyDiscount(200, 25)).toBe(150);\n});\n",
    },
    expectClasses: ['test_assertion'],
    deterministic: false,
    modelReply: {
      summary: 'a discount is a percentage of the price',
      patches: [
        {
          op: 'modify',
          path: 'src/discount.ts',
          content:
            'export function applyDiscount(price: number, percent: number): number {\n  return Math.round(price - (price * percent) / 100);\n}\n',
        },
      ],
    },
    check: (f) =>
      /\/\s*100/.test(f.get('src/discount.ts') ?? '') &&
      (f.get('src/discount.test.ts') ?? '').includes('toBe(150)'),
  },
];

/**
 * A model reply that does what the guards forbid, for the refusal tests: it makes a failing test pass by skipping it (the engine must refuse it and ask again), and a second reply
 * that is honest.
 */
export const CHEATING_REPLY = {
  summary: 'skip the failing test',
  patches: [
    {
      op: 'modify' as const,
      path: 'src/discount.test.ts',
      content:
        "import { applyDiscount } from './discount';\n\ntest.skip('applies a percentage discount', () => {\n  expect(applyDiscount(100, 10)).toBe(90);\n});\n",
    },
  ],
};
