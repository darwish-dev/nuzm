import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSearchDocuments, splitMarkdown, INDEX_LIMITS } from './documents';
import {
  DEFAULT_SETTINGS,
  allowedUsages,
  colourCloseness,
  decide,
  evaluateEligibility,
  pickDefault,
  recommendedUsage,
  scoreCandidate,
  validateSettings,
  type EligibilityInput,
  type Permissions,
  type Requirement,
  type ScoreInput,
} from './rank';
import { groupMatches, indexable, normalizeText, termGroups, tokenize, tsQueryOf } from './text';
import { parseColor } from '../design/color';

describe('text', () => {
  it('normalises Arabic (diacritics, tatweel, alef/yeh/teh-marbuta folding) and English alike', () => {
    expect(normalizeText('لَوْحَةُ التَّحْكُمِ')).toBe('لوحه التحكم');
    expect(normalizeText('أَدَاة إدارة')).toBe('اداه اداره');
    expect(normalizeText('  Dashboard   UI ')).toBe('dashboard ui');
    expect(indexable('متجر')).toContain(normalizeText('متجر'));
    expect(indexable('shop')).toBe('shop');
  });
  it('splits identifiers and drops stop words, one-letter tokens and duplicates', () => {
    expect(tokenize('UserCard user_card user-card')).toEqual(['user', 'card']);
    expect(tokenize('I want to build a web app for the store')).toEqual(['store']);
    expect(tokenize('أريد بناء تطبيق لمتجر')).toEqual(['لمتجر']);
  });
  it('turns an Arabic and an English requirement into the same concept groups', () => {
    const ar = termGroups('أريد متجر إلكتروني مع لوحة تحكم');
    const en = termGroups('online store with an admin dashboard');
    expect(
      ar
        .filter((g) => g.concept)
        .map((g) => g.key)
        .sort(),
    ).toEqual(['dashboard', 'store']);
    expect(
      en
        .filter((g) => g.concept)
        .map((g) => g.key)
        .sort(),
    ).toEqual(['dashboard', 'store']);
    // two words of one concept are ONE group (they must not count twice)
    expect(termGroups('store shop ecommerce').filter((g) => g.key === 'store')).toHaveLength(1);
    expect(termGroups('store shop ecommerce')).toHaveLength(1);
    // a word outside the table is its own group
    expect(termGroups('kubernetes dashboard').map((g) => g.key)).toEqual([
      'kubernetes',
      'dashboard',
    ]);
    expect(termGroups('')).toEqual([]);
    expect(termGroups('a '.repeat(500)).length).toBeLessThanOrEqual(12);
  });
  it('builds a text-search query that can never carry operators', () => {
    const g = termGroups('store')[0]!;
    const q = tsQueryOf(g)!;
    expect(q).toContain('store:*');
    expect(q).toContain('|');
    for (const hostile of [
      "'; DROP TABLE x; --",
      'a & b | !c',
      'foo:* <-> bar',
      '(((',
      '\\u0000',
      'x'.repeat(200),
    ]) {
      const hq = tsQueryOf({ key: 'k', terms: [hostile], from: [hostile], concept: false });
      if (hq !== null) expect(hq).toMatch(/^[\p{L}\p{N}_:*&|() ]+$/u);
    }
    expect(tsQueryOf({ key: 'k', terms: ["'", '!'], from: [], concept: false })).toBeNull();
    expect(tsQueryOf({ key: 'k', terms: ['real estate'], from: [], concept: true })).toBe(
      '(real:* & estate:*)',
    );
  });
  it('matches metadata by word prefix', () => {
    const g = termGroups('dashboard')[0]!;
    expect(groupMatches(normalizeText('Admin Dashboard Pro'), g)).toBe(true);
    expect(groupMatches(normalizeText('Landing page'), g)).toBe(false);
    expect(groupMatches(normalizeText('لوحة تحكم المبيعات'), termGroups('لوحة تحكم')[0]!)).toBe(
      true,
    );
  });
  it('never throws and stays bounded (fuzz)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 800 }), (s) => {
        const g = termGroups(s);
        expect(g.length).toBeLessThanOrEqual(12);
        for (const x of g) {
          const q = tsQueryOf(x);
          if (q) expect(q).toMatch(/^[\p{L}\p{N}_:*&|() ]+$/u);
        }
        expect(tokenize(s).length).toBeLessThanOrEqual(60);
      }),
      { numRuns: 300 },
    );
  });
});

describe('search documents', () => {
  const input = {
    resource: { name: 'Modern SaaS' },
    manifest: {
      frameworks: ['nextjs', 'tailwind'],
      languages: ['typescript'],
      projects: [{ kind: 'application', name: 'shop' }],
      capabilities: [
        { name: 'Authentication', evidence: [{ path: 'src/auth.ts' }] },
        { name: 'Payments' },
      ],
      routes: [
        { path: '/dashboard', file: 'app/dashboard/page.tsx' },
        { path: '/', file: 'app/page.tsx' },
      ],
      screens: [{ name: 'HomeScreen' }],
      architecture: {
        publicSurface: [{ file: 'src/lib/index.ts', exports: ['formatMoney', 'useCart'] }],
      },
    },
    components: [
      {
        name: 'ProductCard',
        kind: 'react-component',
        framework: 'react',
        path: 'src/components/product-card.tsx',
        props: [{ name: 'price' }],
        dependencies: ['react'],
      },
    ],
    dna: {
      primary: 0,
      projects: [
        {
          modes: ['base', 'dark'],
          traits: { darkMode: true, rtl: true, tailwind: true },
          palette: [{ roles: [{ role: 'primary', hex: '#2563eb' }] }],
          typography: { families: [{ value: 'Cairo' }] },
        },
      ],
    },
    markdown: [
      {
        path: 'README.md',
        text: '# Modern SaaS\nA store with checkout.\n\n## Payments\nStripe integration for orders and subscriptions.\n```\nignored code fence content here\n```\n',
      },
    ],
  };
  it('builds summary, feature, component, symbol, design and doc-section documents from facts', () => {
    const d = buildSearchDocuments(input);
    const kinds = new Set(d.map((x) => x.docKind));
    expect([...kinds].sort()).toEqual([
      'COMPONENT',
      'DESIGN',
      'DOC_SECTION',
      'FEATURE',
      'SUMMARY',
      'SYMBOL',
    ]);
    expect(d.find((x) => x.docKind === 'COMPONENT')).toMatchObject({
      ref: 'src/components/product-card.tsx#ProductCard',
      title: 'ProductCard',
    });
    expect(d.find((x) => x.docKind === 'COMPONENT')!.body).toContain('product card');
    expect(d.find((x) => x.docKind === 'SYMBOL')!.body.toLowerCase()).toContain('format money');
    expect(d.find((x) => x.docKind === 'DESIGN')!.body).toMatch(/dark mode.*rtl|rtl.*dark mode/);
    expect(d.find((x) => x.ref === 'route:/dashboard')).toBeTruthy();
    expect(d.find((x) => x.ref === 'route:/')).toBeUndefined(); // the root route says nothing
    expect(d.filter((x) => x.docKind === 'DOC_SECTION').map((x) => x.ref)).toEqual([
      'README.md#modern-saas',
      'README.md#payments',
    ]);
    expect(JSON.stringify(d)).not.toContain('ignored code fence');
    expect(d.every((x) => /^[0-9a-f]{64}$/.test(x.contentHash))).toBe(true);
  });
  it('is deterministic whatever the order of the inputs and has no duplicate (kind, ref)', () => {
    const a = buildSearchDocuments(input);
    const b = buildSearchDocuments({ ...input, components: [...input.components].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a.map((x) => `${x.docKind}|${x.ref}`)).size).toBe(a.length);
  });
  it('is bounded and survives odd facts', () => {
    const many = buildSearchDocuments({
      resource: { name: 'x' },
      manifest: {
        capabilities: Array.from({ length: 500 }, (_, i) => ({ name: `cap${i}` })),
        routes: 'nope',
        projects: null,
      },
      components: Array.from({ length: 2000 }, (_, i) => ({
        name: `C${i}`,
        kind: 'react-component',
        framework: null,
        path: `src/c${i}.tsx`,
        props: [],
        dependencies: [],
      })),
      dna: { projects: 'x' },
      markdown: [],
    });
    expect(many.length).toBeLessThanOrEqual(INDEX_LIMITS.maxDocs);
    expect(many.filter((x) => x.docKind === 'COMPONENT').length).toBe(INDEX_LIMITS.maxComponents);
    expect(
      many.every(
        (x) => x.body.length <= INDEX_LIMITS.maxBody && x.title.length <= INDEX_LIMITS.maxTitle,
      ),
    ).toBe(true);
    expect(() =>
      buildSearchDocuments({
        resource: { name: '' },
        manifest: null,
        components: [],
        dna: null,
        markdown: [],
      }),
    ).not.toThrow();
  });
  it('splits markdown by heading, skips fences and tiny sections, and is bounded', () => {
    const s = splitMarkdown(
      'docs/a.md',
      '# Title\nSome intro text that is long enough.\n## Setup\nshort\n## Usage\nUse the thing like this and that.\n```js\nconst x = 1;\n```\n',
    );
    expect(s.map((x) => x.ref)).toEqual(['docs/a.md#title', 'docs/a.md#usage']);
    expect(splitMarkdown('x.md', '# H\n'.repeat(100_000)).length).toBeLessThan(10);
    expect(splitMarkdown('x.md', 'a'.repeat(5_000_000))).toHaveLength(1);
  });
});

describe('settings', () => {
  it('accepts integer weights that add up to 100 and refuses everything else', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({ ok: true, value: DEFAULT_SETTINGS });
    const bad = (o: unknown) => expect(validateSettings(o)).toMatchObject({ ok: false });
    bad(null);
    bad({});
    bad({ weights: { ...DEFAULT_SETTINGS.weights, functional: 30 }, minScore: 35 });
    bad({ weights: { ...DEFAULT_SETTINGS.weights, functional: 25.5, quality: 9.5 }, minScore: 35 });
    bad({ weights: { ...DEFAULT_SETTINGS.weights, functional: -5, design: 35 }, minScore: 35 });
    bad({ weights: { ...DEFAULT_SETTINGS.weights, extra: 0 }, minScore: 35 });
    bad({ weights: { functional: 100 }, minScore: 35 });
    bad({ weights: DEFAULT_SETTINGS.weights, minScore: 101 });
    bad({ weights: DEFAULT_SETTINGS.weights, minScore: 12.5 });
    bad({ weights: { ...DEFAULT_SETTINGS.weights, functional: '25' }, minScore: 35 });
    expect(
      validateSettings({
        weights: {
          functional: 100,
          framework: 0,
          architecture: 0,
          design: 0,
          quality: 0,
          reuse: 0,
        },
        minScore: 0,
      }),
    ).toMatchObject({ ok: true });
  });
});

const perms = (o: Partial<Permissions> = {}): Permissions => ({
  licenseVerdict: 'ALLOWED',
  reuseScope: 'FULL_STARTER',
  componentReuse: true,
  starterEligible: true,
  architectureReference: true,
  aiProcessing: true,
  ...o,
});
const cand = (o: Partial<EligibilityInput> = {}): EligibilityInput => ({
  deleted: false,
  status: 'ACTIVE',
  visibility: 'PLATFORM_PUBLISHED',
  versionState: 'ACTIVE',
  versionLicense: 'ALLOWED',
  platform: 'WEB',
  frameworks: ['nextjs', 'tailwind'],
  perms: perms(),
  ...o,
});
const req = (o: Partial<Requirement> = {}): Requirement => ({ mode: 'ADAPTIVE', ...o });

describe('hard filters', () => {
  it('a published, licensed, reusable, compatible resource is eligible', () => {
    expect(evaluateEligibility(cand(), req({ platform: 'WEB', frameworks: ['next'] }))).toEqual({
      eligible: true,
      reasons: [],
    });
  });
  it('reports every reason, not just the first', () => {
    const r = evaluateEligibility(
      cand({
        status: 'DISABLED',
        versionState: 'DISABLED',
        visibility: 'PLATFORM_PRIVATE',
        versionLicense: 'UNKNOWN',
        perms: perms({ licenseVerdict: 'UNKNOWN', reuseScope: 'NONE' }),
        platform: 'MOBILE',
      }),
      req({ platform: 'WEB' }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual([
      'not_active',
      'no_active_version',
      'not_published',
      'license_not_allowed',
      'no_reuse_permission',
      'platform_incompatible',
    ]);
  });
  it('archived and deleted resources are excluded as archived only', () => {
    expect(evaluateEligibility(cand({ status: 'ARCHIVED' }), req()).reasons).toContain('archived');
    expect(evaluateEligibility(cand({ deleted: true }), req()).reasons[0]).toBe('archived');
    expect(evaluateEligibility(cand({ status: 'ARCHIVED' }), req()).reasons).not.toContain(
      'not_active',
    );
  });
  it('unknown platform is unsupported; compatible platforms follow the fit table', () => {
    expect(evaluateEligibility(cand({ platform: null }), req({ platform: 'WEB' })).reasons).toEqual(
      ['platform_incompatible'],
    );
    expect(evaluateEligibility(cand({ platform: null }), req()).eligible).toBe(true); // nothing asked, nothing excluded
    expect(
      evaluateEligibility(cand({ platform: 'FULL_STACK' }), req({ platform: 'WEB' })).eligible,
    ).toBe(true);
    expect(
      evaluateEligibility(cand({ platform: 'WEB' }), req({ platform: 'FULL_STACK' })).eligible,
    ).toBe(false);
    expect(
      evaluateEligibility(cand({ platform: 'CROSS_PLATFORM' }), req({ platform: 'MOBILE' }))
        .eligible,
    ).toBe(true);
    expect(
      evaluateEligibility(cand({ platform: 'WEB' }), req({ platform: 'MOBILE' })).eligible,
    ).toBe(false);
  });
  it('frameworks exclude only when required; aliases are understood', () => {
    expect(evaluateEligibility(cand(), req({ frameworks: ['flutter'] })).eligible).toBe(true);
    expect(
      evaluateEligibility(cand(), req({ frameworks: ['flutter'], frameworksRequired: true }))
        .reasons,
    ).toEqual(['framework_incompatible']);
    expect(
      evaluateEligibility(
        cand(),
        req({ frameworks: ['Next.js', 'tailwindcss'], frameworksRequired: true }),
      ).eligible,
    ).toBe(true);
  });
  it('the adaptation mode needs the matching permission', () => {
    const comp = cand({ perms: perms({ reuseScope: 'COMPONENTS', starterEligible: false }) });
    expect(evaluateEligibility(comp, req({ mode: 'STRICT' })).reasons).toEqual([
      'mode_needs_starter',
    ]);
    expect(evaluateEligibility(comp, req({ mode: 'ADAPTIVE' })).eligible).toBe(true);
    const arch = cand({
      perms: perms({
        reuseScope: 'ARCHITECTURE_ONLY',
        componentReuse: false,
        starterEligible: false,
      }),
    });
    expect(evaluateEligibility(arch, req({ mode: 'ADAPTIVE' })).reasons).toEqual([
      'mode_needs_components',
    ]);
    expect(evaluateEligibility(arch, req({ mode: 'CREATIVE' })).eligible).toBe(true);
  });
  it('AI processing is required only when the generation will send source to a model; a pin must match the active version', () => {
    const off = cand({ perms: perms({ aiProcessing: false }) });
    expect(evaluateEligibility(off, req()).eligible).toBe(true);
    expect(evaluateEligibility(off, req({ requiresAiProcessing: true })).reasons).toEqual([
      'ai_processing_not_allowed',
    ]);
    expect(
      evaluateEligibility(cand({ versionId: 'v2', pinnedVersionId: 'v1' }), req()).reasons,
    ).toEqual(['pinned_version_unavailable']);
    expect(
      evaluateEligibility(cand({ versionId: 'v1', pinnedVersionId: 'v1' }), req()).eligible,
    ).toBe(true);
  });
  it('permissions with no row mean no reuse', () => {
    expect(evaluateEligibility(cand({ perms: null }), req()).reasons).toEqual(
      expect.arrayContaining(['license_not_allowed', 'no_reuse_permission']),
    );
  });
  it('usages follow the permissions and the mode', () => {
    expect(allowedUsages(perms())).toEqual(['FULL_STARTER', 'COMPONENTS', 'ARCHITECTURE_ONLY']);
    expect(allowedUsages(perms({ reuseScope: 'NONE' }))).toEqual([]);
    expect(allowedUsages(null)).toEqual([]);
    expect(recommendedUsage(perms(), 'STRICT')).toBe('FULL_STARTER');
    expect(recommendedUsage(perms(), 'ADAPTIVE')).toBe('FULL_STARTER');
    expect(recommendedUsage(perms(), 'CREATIVE')).toBe('ARCHITECTURE_ONLY');
    expect(
      recommendedUsage(perms({ reuseScope: 'COMPONENTS', starterEligible: false }), 'ADAPTIVE'),
    ).toBe('COMPONENTS');
    expect(
      recommendedUsage(perms({ reuseScope: 'COMPONENTS', starterEligible: false }), 'STRICT'),
    ).toBeNull();
  });
});

const base = (o: Partial<ScoreInput> = {}): ScoreInput => ({
  req: req(),
  functional: null,
  frameworks: ['nextjs', 'tailwind'],
  platform: 'WEB',
  architecture: null,
  componentCount: 0,
  dna: null,
  quality: [],
  perms: perms(),
  ...o,
});
const dim = (s: ReturnType<typeof scoreCandidate>, id: string) =>
  s.dimensions.find((d) => d.dimension === id)!;

describe('weighted model (D-48)', () => {
  it('with every dimension exercised the default weights apply as configured', () => {
    const s = scoreCandidate(
      base({
        req: req({
          text: 'store',
          platform: 'WEB',
          frameworks: ['nextjs'],
          design: { darkMode: true },
        }),
        functional: { groups: 1, matched: [{ group: 'store', weight: 1 }] },
        architecture: {
          layers: [1, 2],
          cycles: [],
          entryReachability: { roots: 1, analysedFiles: 10, unreachable: 0 },
        },
        componentCount: 5,
        dna: { traits: { darkMode: true } },
        quality: [{ dimension: 'BUILD', score: 100 }],
      }),
      DEFAULT_SETTINGS,
    );
    expect(s.confidence).toBe(100);
    expect(s.score).toBe(100);
    expect(s.dimensions.map((d) => d.effectiveWeight)).toEqual([25, 20, 20, 15, 10, 10]);
    expect(s.dimensions.reduce((a, d) => a + d.points, 0)).toBeCloseTo(100, 1);
  });
  it('dimensions the requirement does not exercise or that have no evidence are excluded and the rest renormalised; confidence says how much was exercised', () => {
    const s = scoreCandidate(
      base({
        req: req({ text: 'store' }),
        functional: { groups: 2, matched: [{ group: 'store', weight: 1 }] },
      }),
      DEFAULT_SETTINGS,
    );
    expect(dim(s, 'framework')).toMatchObject({
      applicable: false,
      score: null,
      effectiveWeight: 0,
      note: 'framework.none_requested',
    });
    expect(dim(s, 'quality')).toMatchObject({
      applicable: false,
      score: null,
      note: 'quality.not_measured',
    });
    expect(dim(s, 'design').applicable).toBe(false);
    expect(dim(s, 'architecture').applicable).toBe(false);
    // functional (25) and reuse (10) are exercised: 35 of 100 of the configured weight
    expect(s.confidence).toBe(35);
    expect(dim(s, 'functional').effectiveWeight).toBeCloseTo(71.4, 1);
    expect(dim(s, 'reuse').effectiveWeight).toBeCloseTo(28.6, 1);
    // half of the groups covered (0.5) at 71.4% plus a full reuse (1.0) at 28.6%
    expect(s.score).toBeCloseTo(0.5 * 71.4 + 28.6, 0);
  });
  it('coverage counts each group once, weighted by where it was found', () => {
    const only = (m: { group: string; weight: number }[]) =>
      dim(
        scoreCandidate(
          base({ req: req({ text: 'x' }), functional: { groups: 4, matched: m } }),
          DEFAULT_SETTINGS,
        ),
        'functional',
      ).score;
    expect(only([])).toBe(0);
    expect(
      only([
        { group: 'a', weight: 1 },
        { group: 'b', weight: 0.4 },
      ]),
    ).toBeCloseTo(0.35, 5);
    expect(only(Array.from({ length: 4 }, (_, i) => ({ group: `g${i}`, weight: 1 })))).toBe(1);
  });
  it('framework share, architecture structure and platform fit, quality only when measured, reuse scope', () => {
    const s = scoreCandidate(
      base({
        req: req({ frameworks: ['nextjs', 'vue'], platform: 'WEB' }),
        platform: 'FULL_STACK',
        architecture: {
          layers: [1],
          cycles: [1, 2, 3, 4, 5, 6],
          entryReachability: { roots: 1, analysedFiles: 10, unreachable: 5 },
        },
        componentCount: 3,
        quality: [
          { dimension: 'BUILD', score: 80 },
          { dimension: 'TEST', score: null },
          { dimension: 'DESIGN', score: 60 },
        ],
        perms: perms({ reuseScope: 'COMPONENTS' }),
      }),
      DEFAULT_SETTINGS,
    );
    expect(dim(s, 'framework').score).toBe(0.5);
    const structure = 0.12 + 0 + 0.125 + 0.25; // one layer, five or more cycles, half reachable, components analysed
    expect(dim(s, 'architecture').score).toBeCloseTo(0.6 * structure + 0.4 * 0.8, 3);
    expect(dim(s, 'architecture').note).toBe('architecture.structure_and_fit');
    expect(dim(s, 'quality')).toMatchObject({ score: 0.7, detail: { measured: 2 } });
    expect(dim(s, 'reuse').score).toBe(0.7);
  });
  it('design hints are met, unmet or unknown; a colour is compared by distance', () => {
    const dna = {
      traits: { darkMode: true, rtl: false },
      palette: [{ mode: 'base', roles: [{ role: 'primary', hex: '#2563eb' }] }],
    };
    const r = (d: Requirement['design'], withDna = true) =>
      dim(
        scoreCandidate(
          base({ req: req({ design: d }), dna: withDna ? dna : null }),
          DEFAULT_SETTINGS,
        ),
        'design',
      );
    expect(r({ darkMode: true, rtl: true }).score).toBe(0.5);
    expect(r({ primaryColor: '#2563eb' }).score).toBe(1);
    expect(r({ primaryColor: '#ff0000' }).score!).toBeLessThan(0.3);
    expect(r({ darkMode: true }, false)).toMatchObject({ score: 0, note: 'design.no_dna' });
    expect(r({})).toMatchObject({ applicable: false });
    expect(colourCloseness(parseColor('#000')!, parseColor('#000')!)).toBe(1);
    expect(colourCloseness(parseColor('#000')!, parseColor('#fff')!)).toBe(0);
  });
  it('a resource that meets none of what was asked scores 0 however well built it is (the relevance gate)', () => {
    const strong = {
      architecture: {
        layers: [1, 2],
        cycles: [],
        entryReachability: { roots: 1, analysedFiles: 10, unreachable: 0 },
      },
      componentCount: 9,
      quality: [{ dimension: 'BUILD', score: 100 }],
    };
    const none = scoreCandidate(
      base({ ...strong, req: req({ text: 'x' }), functional: { groups: 2, matched: [] } }),
      DEFAULT_SETTINGS,
    );
    expect(none).toMatchObject({ score: 0, gated: true });
    expect(none.dimensions.every((d) => d.points === 0)).toBe(true);
    // intrinsic quality is still reported, only the score is gated
    expect(dim(none, 'architecture').score).toBeGreaterThan(0.9);
    // one requirement-driven dimension met is enough to open the gate
    const some = scoreCandidate(
      base({
        ...strong,
        req: req({ text: 'x', frameworks: ['nextjs'] }),
        functional: { groups: 2, matched: [] },
      }),
      DEFAULT_SETTINGS,
    );
    expect(some.gated).toBe(false);
    expect(some.score).toBeGreaterThan(0);
    // a requirement with no needs of its own (platform and mode only) ranks on the intrinsic dimensions
    const generic = scoreCandidate(
      base({ ...strong, req: req({ platform: 'WEB' }) }),
      DEFAULT_SETTINGS,
    );
    expect(generic.gated).toBe(false);
    expect(generic.score).toBeGreaterThan(80);
    // an unmet design hint alone gates too
    expect(
      scoreCandidate(
        base({
          ...strong,
          req: req({ design: { darkMode: true } }),
          dna: { traits: { darkMode: false } },
        }),
        DEFAULT_SETTINGS,
      ).gated,
    ).toBe(true);
  });
  it('a zero weight removes a dimension; all-zero applicable weights give score 0 and confidence 0', () => {
    const s = scoreCandidate(base(), {
      ...DEFAULT_SETTINGS,
      weights: { functional: 100, framework: 0, architecture: 0, design: 0, quality: 0, reuse: 0 },
    });
    expect(s).toMatchObject({ score: 0, confidence: 0 });
    const w = scoreCandidate(base(), {
      ...DEFAULT_SETTINGS,
      weights: { functional: 0, framework: 0, architecture: 0, design: 0, quality: 0, reuse: 100 },
    });
    expect(w.score).toBe(100);
  });
  it('is deterministic and stays within 0-100 (fuzz)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            group: fc.string({ maxLength: 5 }),
            weight: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 8 }),
        fc.array(fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }), { maxLength: 4 }),
        (matched, groups, q) => {
          const i = base({
            req: req({ text: 'x', frameworks: ['a'], platform: 'WEB', design: { darkMode: true } }),
            functional: { groups, matched },
            quality: q.map((score, n) => ({ dimension: `d${n}`, score })),
          });
          const a = scoreCandidate(i, DEFAULT_SETTINGS);
          expect(JSON.stringify(a)).toBe(JSON.stringify(scoreCandidate(i, DEFAULT_SETTINGS)));
          expect(a.score).toBeGreaterThanOrEqual(0);
          expect(a.score).toBeLessThanOrEqual(100);
          expect(a.confidence).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('strategy', () => {
  const rule = (o: Partial<Parameters<typeof pickDefault>[0][number]> = {}) => ({
    platform: '*',
    framework: '*',
    category: '*',
    plan: '*',
    mode: '*',
    resourceId: 'r1',
    versionPin: null,
    ...o,
  });
  it('admin defaults: the most specific rule wins, wildcards match anything, ties are stable', () => {
    const rules = [
      rule({ resourceId: 'any' }),
      rule({ resourceId: 'web', platform: 'WEB' }),
      rule({ resourceId: 'web-next', platform: 'WEB', framework: 'nextjs' }),
      rule({ resourceId: 'mobile', platform: 'MOBILE' }),
    ];
    expect(pickDefault(rules, req({ platform: 'WEB', frameworks: ['Next.js'] }))!.resourceId).toBe(
      'web-next',
    );
    expect(pickDefault(rules, req({ platform: 'WEB' }))!.resourceId).toBe('web');
    expect(pickDefault(rules, req({ platform: 'BACKEND' }))!.resourceId).toBe('any');
    expect(
      pickDefault(
        [rule({ resourceId: 'b', platform: 'WEB' }), rule({ resourceId: 'a', platform: 'WEB' })],
        req({ platform: 'WEB' }),
      )!.resourceId,
    ).toBe('a');
    expect(pickDefault([rule({ platform: 'MOBILE' })], req({ platform: 'WEB' }))).toBeNull();
    expect(
      pickDefault(
        [rule({ mode: 'STRICT', category: 'Dashboard' })],
        req({ mode: 'STRICT', category: 'dashboard' }),
      ),
    ).not.toBeNull();
    expect(pickDefault([], req())).toBeNull();
  });
  const ranked = [
    { resourceId: 'a', score: 80 },
    { resourceId: 'b', score: 60 },
  ];
  it('AUTO_SELECT picks the best above the minimum and otherwise says generate from scratch', () => {
    expect(
      decide({ requested: 'AUTO_SELECT', ranked, adminDefault: null, minScore: 35 }),
    ).toMatchObject({ strategy: 'AUTO_SELECT', selectedResourceId: 'a' });
    expect(
      decide({ requested: 'AUTO_SELECT', ranked, adminDefault: null, minScore: 90 }),
    ).toMatchObject({
      strategy: 'GENERATE_FROM_SCRATCH',
      selectedResourceId: null,
      notes: ['below_min_score'],
    });
    expect(
      decide({ requested: 'AUTO_SELECT', ranked: [], adminDefault: null, minScore: 0 }),
    ).toMatchObject({ strategy: 'GENERATE_FROM_SCRATCH', notes: ['no_eligible_resource'] });
  });
  it('a user choice is honoured when eligible and NEVER substituted when not', () => {
    expect(
      decide({
        requested: 'USER_SELECTED',
        resourceId: 'b',
        ranked,
        adminDefault: null,
        minScore: 35,
      }),
    ).toMatchObject({ strategy: 'USER_SELECTED', selectedResourceId: 'b' });
    expect(
      decide({
        requested: 'USER_SELECTED',
        resourceId: 'zzz',
        ranked,
        adminDefault: null,
        minScore: 35,
      }),
    ).toMatchObject({
      strategy: 'USER_SELECTED',
      selectedResourceId: null,
      notes: ['user_choice_ineligible'],
    });
    expect(
      decide({ requested: 'USER_SELECTED', ranked, adminDefault: null, minScore: 35 })
        .selectedResourceId,
    ).toBeNull();
  });
  it('an admin default is used only when eligible; otherwise the automatic choice is used and says why', () => {
    expect(
      decide({
        requested: 'ADMIN_DEFAULT',
        ranked,
        adminDefault: { resourceId: 'b', eligible: true },
        minScore: 35,
      }),
    ).toMatchObject({ strategy: 'ADMIN_DEFAULT', selectedResourceId: 'b' });
    expect(
      decide({
        requested: 'ADMIN_DEFAULT',
        ranked,
        adminDefault: { resourceId: 'z', eligible: false },
        minScore: 35,
      }),
    ).toMatchObject({
      strategy: 'AUTO_SELECT',
      selectedResourceId: 'a',
      notes: ['admin_default_ineligible', 'auto_selected'],
    });
    expect(
      decide({ requested: 'ADMIN_DEFAULT', ranked, adminDefault: null, minScore: 35 }).notes,
    ).toEqual(['admin_default_none', 'auto_selected']);
  });
  it('generate from scratch is honoured', () => {
    expect(
      decide({ requested: 'GENERATE_FROM_SCRATCH', ranked, adminDefault: null, minScore: 0 }),
    ).toMatchObject({ strategy: 'GENERATE_FROM_SCRATCH', selectedResourceId: null });
  });
});
