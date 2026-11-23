// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import {
  requirementBody,
  triState,
  weightsTotal,
  type DefaultView,
  type EngineSettingsView,
  type RecommendationView,
  type RecommendedView,
  type RevisionView,
  type SearchHit,
  type SearchResult,
} from '../lib/knowledge-retrieval';
import { KnowledgeRetrieval } from './KnowledgeRetrieval';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Seen {
  method: string;
  url: string;
  search: string;
  body: unknown;
  ifMatch: string | null;
}
let seen: Seen[] = [];
type Handler = (s: Seen) => Response | Promise<Response> | undefined;
const RealRequest = globalThis.Request;
const mockFetch = (h: Handler) => {
  seen = [];
  vi.stubGlobal(
    'Request',
    class extends RealRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input,
          init,
        );
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const req = input instanceof Request ? input : null;
      const u = new URL(req ? req.url : String(input), 'http://localhost');
      const raw = req
        ? await req
            .clone()
            .text()
            .catch(() => '')
        : (init.body as string | undefined);
      const entry: Seen = {
        method: (req?.method ?? init.method ?? 'GET').toUpperCase(),
        url: u.pathname,
        search: u.search,
        body: raw ? JSON.parse(raw) : undefined,
        ifMatch: req?.headers.get('if-match') ?? null,
      };
      seen.push(entry);
      return (await h(entry)) ?? json(404, {});
    }),
  );
};
beforeEach(() => {
  document.cookie = 'nuzm_admin_csrf=csrf-123';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const en = (k: Parameters<typeof t>[1], p?: Record<string, string | number>) => t('en', k, p);
const hit = (o: Partial<SearchHit> = {}): SearchHit => ({
  resourceId: '00000000-0000-7000-8000-000000000001',
  versionId: '00000000-0000-7000-8000-0000000000a1',
  versionSeq: 1,
  name: 'Admin Dashboard Pro',
  description: null,
  resourceType: 'THEME',
  platform: 'WEB',
  frameworks: ['nextjs'],
  category: null,
  tags: [],
  status: 'ACTIVE',
  relevance: 50,
  matchedGroups: ['dashboard'],
  matches: [
    { kind: 'SUMMARY', ref: 'summary', title: 'Admin Dashboard Pro', snippet: 'dashboard' },
  ],
  components: [{ name: 'DataTable', ref: 'src/data-table.tsx#DataTable' }],
  eligibility: { eligible: true, reasons: [] },
  license: { spdx: 'MIT', verdict: 'ALLOWED' },
  ...o,
});
const search = (items: SearchHit[], text = 'dashboard'): SearchResult => ({
  query: { text, groups: text ? [{ key: 'dashboard', from: ['dashboard'], concept: true }] : [] },
  total: items.length,
  items,
});
const dims = (): RecommendedView['dimensions'] => [
  {
    dimension: 'functional',
    weight: 25,
    effectiveWeight: 71.4,
    score: 0.5,
    applicable: true,
    points: 35.7,
    note: 'functional.coverage',
  },
  {
    dimension: 'framework',
    weight: 20,
    effectiveWeight: 0,
    score: null,
    applicable: false,
    points: 0,
    note: 'framework.none_requested',
  },
  {
    dimension: 'architecture',
    weight: 20,
    effectiveWeight: 0,
    score: null,
    applicable: false,
    points: 0,
    note: 'architecture.not_analysed',
  },
  {
    dimension: 'design',
    weight: 15,
    effectiveWeight: 0,
    score: null,
    applicable: false,
    points: 0,
    note: 'design.no_hints',
  },
  {
    dimension: 'quality',
    weight: 10,
    effectiveWeight: 0,
    score: null,
    applicable: false,
    points: 0,
    note: 'quality.not_measured',
  },
  {
    dimension: 'reuse',
    weight: 10,
    effectiveWeight: 28.6,
    score: 1,
    applicable: true,
    points: 28.6,
    note: 'reuse.scope',
  },
];
const cand = (o: Partial<RecommendedView> = {}): RecommendedView => ({
  resourceId: '00000000-0000-7000-8000-000000000002',
  versionId: '00000000-0000-7000-8000-0000000000a2',
  versionSeq: 1,
  name: 'Store Starter',
  resourceType: 'THEME',
  platform: 'WEB',
  frameworks: ['nextjs'],
  category: null,
  score: 64.3,
  confidence: 35,
  gated: false,
  dimensions: dims(),
  usage: { recommended: 'FULL_STARTER', allowed: ['FULL_STARTER'] },
  license: { spdx: 'MIT', verdict: 'ALLOWED' },
  matches: [],
  components: [{ name: 'CartDrawer', ref: 'src/cart.tsx#CartDrawer' }],
  ...o,
});
const rec = (o: Partial<RecommendationView> = {}): RecommendationView => ({
  requirement: { groups: [{ key: 'store', from: ['store'], concept: true }] },
  settings: {
    weights: {
      functional: 25,
      framework: 20,
      architecture: 20,
      design: 15,
      quality: 10,
      reuse: 10,
    },
    minScore: 35,
    revision: 0,
  },
  decision: {
    requested: 'AUTO_SELECT',
    strategy: 'AUTO_SELECT',
    selectedResourceId: '00000000-0000-7000-8000-000000000002',
    notes: ['auto_selected'],
  },
  selected: cand(),
  userChoice: null,
  adminDefault: null,
  ranked: [
    cand(),
    cand({
      resourceId: '00000000-0000-7000-8000-000000000003',
      name: 'Gym Mobile',
      score: 20,
      confidence: 35,
      platform: 'MOBILE',
    }),
  ],
  alternatives: [],
  excluded: [
    {
      resourceId: '00000000-0000-7000-8000-000000000004',
      name: 'Private Draft',
      reasons: ['not_published', 'license_not_allowed'],
    },
  ],
  stats: { considered: 5, eligible: 2, ranked: 2, excluded: 3, truncated: false },
  ...o,
});
const settings = (o: Partial<EngineSettingsView> = {}): EngineSettingsView => ({
  weights: { functional: 25, framework: 20, architecture: 20, design: 15, quality: 10, reuse: 10 },
  minScore: 35,
  revision: 0,
  updatedAt: null,
  updatedBy: null,
  defaults: {
    weights: {
      functional: 25,
      framework: 20,
      architecture: 20,
      design: 15,
      quality: 10,
      reuse: 10,
    },
    minScore: 35,
  },
  isDefault: true,
  ...o,
});
interface World {
  search?: SearchResult | Response;
  recommend?: RecommendationView | Response;
  settings?: EngineSettingsView | Response;
  revisions?: RevisionView[];
  defaults?: DefaultView[];
  put?: Response;
}
const world =
  (w: World = {}): Handler =>
  (s) => {
    if (s.url.endsWith('/search'))
      return w.search instanceof Response ? w.search.clone() : json(200, w.search ?? search([]));
    if (s.url.endsWith('/recommendations'))
      return w.recommend instanceof Response
        ? w.recommend.clone()
        : json(200, w.recommend ?? rec());
    if (s.url.endsWith('/settings/recommendation/revisions'))
      return json(200, { items: w.revisions ?? [] });
    if (s.url.endsWith('/settings/recommendation')) {
      if (s.method === 'PUT')
        return w.put ? w.put.clone() : json(200, settings({ revision: 1, isDefault: false }));
      return w.settings instanceof Response
        ? w.settings.clone()
        : json(200, w.settings ?? settings());
    }
    if (s.url.endsWith('/defaults')) return json(200, { items: w.defaults ?? [] });
    return undefined;
  };
const ui = (props: Partial<{ locale: 'ar' | 'en'; canPublish: boolean }> = {}) =>
  render(
    <KnowledgeRetrieval locale={props.locale ?? 'en'} canPublish={props.canPublish ?? true} />,
  );

describe('requirement form → request body', () => {
  const empty = {
    text: '',
    platform: '',
    frameworks: '',
    frameworksRequired: false,
    mode: 'ADAPTIVE',
    strategy: 'AUTO_SELECT',
    resourceId: '',
    requiresAi: false,
    dark: '',
    rtl: '',
    arabicFont: '',
    tailwind: '',
    primaryColor: '',
  };
  it('leaves empty fields out and keeps only what the person set', () => {
    expect(requirementBody(empty)).toEqual({ mode: 'ADAPTIVE', strategy: 'AUTO_SELECT' });
    expect(
      requirementBody({
        ...empty,
        text: '  متجر  ',
        platform: 'WEB',
        frameworks: 'nextjs، tailwind  react',
        frameworksRequired: true,
        strategy: 'USER_SELECTED',
        resourceId: ' abc ',
        requiresAi: true,
        dark: 'yes',
        rtl: 'no',
        primaryColor: ' #2563eb ',
      }),
    ).toEqual({
      mode: 'ADAPTIVE',
      strategy: 'USER_SELECTED',
      text: 'متجر',
      platform: 'WEB',
      frameworks: ['nextjs', 'tailwind', 'react'],
      frameworksRequired: true,
      resourceId: 'abc',
      requiresAiProcessing: true,
      design: { darkMode: true, rtl: false, primaryColor: '#2563eb' },
    });
    expect(requirementBody({ ...empty, frameworksRequired: true })).not.toHaveProperty(
      'frameworksRequired',
    ); // required needs frameworks
    expect(requirementBody({ ...empty, resourceId: 'abc' })).not.toHaveProperty('resourceId'); // only for USER_SELECTED
    expect(triState('yes')).toBe(true);
    expect(triState('no')).toBe(false);
    expect(triState('')).toBeUndefined();
    expect(
      weightsTotal({
        functional: '25',
        framework: 20,
        architecture: 'x',
        design: 15,
        quality: 10,
        reuse: 10,
      }),
    ).toBe(80);
  });
});

describe('KnowledgeRetrieval: search', () => {
  it('sends the filters, shows relevance, eligibility with reasons, evidence and what the text was understood as', async () => {
    mockFetch(
      world({
        search: search([
          hit(),
          hit({
            resourceId: '00000000-0000-7000-8000-000000000009',
            name: 'Private Dashboard',
            relevance: 25,
            eligibility: { eligible: false, reasons: ['not_published', 'no_reuse_permission'] },
            components: [],
            matches: [],
          }),
        ]),
      }),
    );
    ui();
    const card = screen.getByLabelText(en('kr.search.title'));
    fireEvent.change(within(card).getByLabelText(en('kr.search.q')), {
      target: { value: 'لوحة تحكم' },
    });
    fireEvent.change(within(card).getByLabelText(en('kr.platform')), { target: { value: 'WEB' } });
    fireEvent.change(within(card).getByLabelText(en('kr.framework')), {
      target: { value: 'next.js' },
    });
    fireEvent.change(within(card).getByLabelText(en('kr.search.eligible')), {
      target: { value: 'false' },
    });
    fireEvent.click(within(card).getByRole('button', { name: en('kr.search.run') }));
    const table = await within(card).findByRole('table', { name: en('kr.search.title') });
    const q = new URLSearchParams(seen.find((x) => x.url.endsWith('/search'))!.search);
    expect(Object.fromEntries(q)).toEqual({
      q: 'لوحة تحكم',
      platform: 'WEB',
      framework: 'next.js',
      eligible: 'false',
      limit: '20',
    });
    expect(within(table).getByText('Admin Dashboard Pro')).toBeTruthy();
    expect(within(table).getByText('50%')).toBeTruthy();
    expect(within(table).getByText(en('kr.eligible'))).toBeTruthy();
    expect(within(table).getByText(en('kr.ineligible'))).toBeTruthy();
    expect(
      within(table).getByText(
        new RegExp(`${en('kr.reason.not_published')}.*${en('kr.reason.no_reuse_permission')}`),
      ),
    ).toBeTruthy();
    expect(within(table).getByText('DataTable')).toBeTruthy();
    expect(
      within(card).getByText(en('kr.search.results', { n: 2 }), { exact: false }),
    ).toBeTruthy();
    expect(
      within(card).getByText(en('kr.concept.dashboard'), { selector: '.nz-badge' }),
    ).toBeTruthy(); // the Arabic text was understood as the dashboard concept
    expect(
      within(table).getByRole('link', { name: 'Admin Dashboard Pro' }).getAttribute('href'),
    ).toBe('/en/ai-intelligence/library/00000000-0000-7000-8000-000000000001');
  });
  it('says when nothing matches, and when the search fails', async () => {
    mockFetch(world({ search: search([], '') }));
    ui();
    const card = screen.getByLabelText(en('kr.search.title'));
    fireEvent.click(within(card).getByRole('button', { name: en('kr.search.run') }));
    expect(await within(card).findByText(en('kr.search.none'))).toBeTruthy();
    cleanup();
    mockFetch(world({ search: json(500, {}) }));
    ui();
    const c2 = screen.getByLabelText(en('kr.search.title'));
    fireEvent.click(within(c2).getByRole('button', { name: en('kr.search.run') }));
    expect(await within(c2).findByRole('alert')).toBeTruthy();
  });
});

describe('KnowledgeRetrieval: recommendation', () => {
  it('computes, shows the decision, the selected resource, scores with a breakdown that says what did not apply, and the exclusions with every reason', async () => {
    mockFetch(world({ recommend: rec() }));
    ui();
    const card = screen.getByLabelText(en('kr.rec.title'));
    fireEvent.change(within(card).getByLabelText(en('kr.rec.text')), {
      target: { value: 'online store' },
    });
    fireEvent.change(
      within(card).getByLabelText(en('kr.platform'), { selector: '#kr-rec-platform' }),
      { target: { value: 'WEB' } },
    );
    fireEvent.change(within(card).getByLabelText(en('kd.trait.darkMode')), {
      target: { value: 'yes' },
    });
    fireEvent.click(within(card).getByRole('button', { name: en('kr.rec.run') }));
    const result = await within(card).findByLabelText(en('kr.result'));
    expect(seen.find((x) => x.url.endsWith('/recommendations'))!.body).toEqual({
      mode: 'ADAPTIVE',
      strategy: 'AUTO_SELECT',
      text: 'online store',
      platform: 'WEB',
      design: { darkMode: true },
    });
    expect(
      within(result).getByText(en('kr.decision.auto_selected'), { exact: false }),
    ).toBeTruthy();
    expect(
      within(result).getByText(en('kr.strategy.AUTO_SELECT'), { selector: '.nz-badge' }),
    ).toBeTruthy();
    const store = within(result).getByLabelText('Store Starter');
    expect(within(store).getByText(en('kr.selected'))).toBeTruthy();
    expect(
      within(store)
        .getByRole('progressbar', { name: /Store Starter/ })
        .getAttribute('value'),
    ).toBe('64.3');
    expect(within(store).getByText(en('kr.usage.FULL_STARTER'), { exact: false })).toBeTruthy();
    expect(within(result).queryByLabelText('Gym Mobile')!.textContent).not.toContain(
      en('kr.selected'),
    );
    // the breakdown opens on demand and says why each dimension counted or not
    fireEvent.click(within(store).getByRole('button', { name: en('kc.details') }));
    const table = await within(store).findByRole('table', { name: /Store Starter/ });
    expect(within(table).getByText(en('kr.dimension.functional'))).toBeTruthy();
    expect(within(table).getByText(en('kr.note.quality.not_measured'))).toBeTruthy();
    expect(within(table).getAllByText(en('kr.na')).length).toBe(4);
    expect(within(table).getByText('71.4% (25)')).toBeTruthy();
    // the exclusions are listed with every reason, and the filters are named as hard
    expect(within(result).getByText(en('kr.excluded.note'))).toBeTruthy();
    expect(within(result).getByText('Private Draft')).toBeTruthy();
    expect(
      within(result).getByText(
        new RegExp(`${en('kr.reason.not_published')}.*${en('kr.reason.license_not_allowed')}`),
      ),
    ).toBeTruthy();
    expect(
      within(result).getByText(en('kr.stats', { considered: 5, eligible: 2, excluded: 3 }), {
        exact: false,
      }),
    ).toBeTruthy();
  });

  it('a user choice that cannot be used is explained and never substituted; alternatives are only shown', async () => {
    mockFetch(
      world({
        recommend: rec({
          decision: {
            requested: 'USER_SELECTED',
            strategy: 'USER_SELECTED',
            selectedResourceId: null,
            notes: ['user_choice_ineligible'],
          },
          selected: null,
          userChoice: {
            resourceId: '00000000-0000-7000-8000-000000000004',
            name: 'Private Draft',
            reasons: ['not_published'],
          },
          alternatives: [cand()],
        }),
      }),
    );
    ui();
    const card = screen.getByLabelText(en('kr.rec.title'));
    fireEvent.change(within(card).getByLabelText(en('kr.rec.strategy')), {
      target: { value: 'USER_SELECTED' },
    });
    fireEvent.change(within(card).getByLabelText(en('kr.rec.resourceId')), {
      target: { value: '00000000-0000-7000-8000-000000000004' },
    });
    fireEvent.click(within(card).getByRole('button', { name: en('kr.rec.run') }));
    const result = await within(card).findByLabelText(en('kr.result'));
    expect(seen.find((x) => x.url.endsWith('/recommendations'))!.body).toMatchObject({
      strategy: 'USER_SELECTED',
      resourceId: '00000000-0000-7000-8000-000000000004',
    });
    expect(within(result).getByRole('alert').textContent).toContain(en('kr.reason.not_published'));
    expect(
      within(result).getByText(en('kr.decision.user_choice_ineligible'), { exact: false }),
    ).toBeTruthy();
    expect(within(result).getByText(en('kr.alternatives.note'))).toBeTruthy();
    expect(within(result).queryByText(en('kr.selected'))).toBeNull(); // nothing is marked as selected
  });

  it('a gated resource says so; nothing eligible and generate-from-scratch are explained', async () => {
    mockFetch(
      world({
        recommend: rec({
          ranked: [cand({ score: 0, gated: true })],
          selected: null,
          decision: {
            requested: 'AUTO_SELECT',
            strategy: 'GENERATE_FROM_SCRATCH',
            selectedResourceId: null,
            notes: ['below_min_score'],
          },
        }),
      }),
    );
    ui();
    const card = screen.getByLabelText(en('kr.rec.title'));
    fireEvent.click(within(card).getByRole('button', { name: en('kr.rec.run') }));
    const result = await within(card).findByLabelText(en('kr.result'));
    expect(
      within(result).getByText(en('kr.decision.below_min_score'), { exact: false }),
    ).toBeTruthy();
    fireEvent.click(within(result).getByRole('button', { name: en('kc.details') }));
    expect(await within(result).findByText(en('kr.gated'))).toBeTruthy();
    cleanup();
    mockFetch(
      world({
        recommend: rec({
          ranked: [],
          selected: null,
          excluded: [],
          decision: {
            requested: 'AUTO_SELECT',
            strategy: 'GENERATE_FROM_SCRATCH',
            selectedResourceId: null,
            notes: ['no_eligible_resource'],
          },
        }),
      }),
    );
    ui();
    const c2 = screen.getByLabelText(en('kr.rec.title'));
    fireEvent.click(within(c2).getByRole('button', { name: en('kr.rec.run') }));
    expect(await within(c2).findByText(en('kr.ranked.none'))).toBeTruthy();
    expect(within(c2).getByText(en('kr.excluded.none'))).toBeTruthy();
  });

  it('shows a plain message for an invalid requirement (422) and for a failure', async () => {
    mockFetch(world({ recommend: json(422, {}) }));
    ui();
    const card = screen.getByLabelText(en('kr.rec.title'));
    fireEvent.click(within(card).getByRole('button', { name: en('kr.rec.run') }));
    expect((await within(card).findByRole('alert')).textContent).toBe(en('kr.rec.invalid'));
    cleanup();
    mockFetch(world({ recommend: json(500, {}) }));
    ui();
    const c2 = screen.getByLabelText(en('kr.rec.title'));
    fireEvent.click(within(c2).getByRole('button', { name: en('kr.rec.run') }));
    expect((await within(c2).findByRole('alert')).textContent).toBe(en('kr.error'));
  });
});

describe('KnowledgeRetrieval: weights', () => {
  it('shows the weights, history and defaults; saving sends the current revision and the reason, then reloads', async () => {
    mockFetch(
      world({
        settings: settings({ revision: 2, isDefault: false }),
        revisions: [
          {
            revision: 2,
            value: {
              weights: {
                functional: 25,
                framework: 20,
                architecture: 20,
                design: 15,
                quality: 10,
                reuse: 10,
              },
              minScore: 35,
            },
            previous: null,
            changedBy: 'u',
            reason: 'Back to the initial configuration.',
            createdAt: '2026-11-21T10:00:00Z',
          },
        ],
        defaults: [
          {
            id: 'd1',
            platform: 'WEB',
            framework: '*',
            category: '*',
            plan: '*',
            mode: '*',
            resourceId: 'r1',
            resourceName: 'Store Starter',
            versionPin: null,
            updatedAt: null,
          },
        ],
      }),
    );
    ui();
    const card = await screen.findByLabelText(en('kr.set.title'));
    expect(
      await within(card).findByText(en('kr.set.revision', { n: 2 }), { selector: '.nz-badge' }),
    ).toBeTruthy();
    expect(
      within(card).getByText('Back to the initial configuration.', { exact: false }),
    ).toBeTruthy();
    expect(within(card).getByText('25/20/20/15/10/10 · 35')).toBeTruthy();
    expect(within(card).getByText('Store Starter')).toBeTruthy();
    const save = within(card).getByRole('button', { name: en('kr.set.save') }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // no reason yet
    fireEvent.change(within(card).getByLabelText(en('kr.dimension.functional')), {
      target: { value: '30' },
    });
    expect(within(card).getByText(en('kr.set.sum.bad', { n: 105 }))).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(en('kr.dimension.reuse')), {
      target: { value: '5' },
    });
    expect(within(card).getByText(en('kr.set.sum', { n: 100 }))).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(en('kr.set.reason')), {
      target: { value: 'Prefer functional fit now.' },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await within(card).findByText(en('kr.set.saved'))).toBeTruthy();
    const put = seen.find((x) => x.method === 'PUT')!;
    expect(put.url).toBe('/v1/admin/knowledge/settings/recommendation');
    expect(put.ifMatch).toBe('2');
    expect(put.body).toEqual({
      weights: {
        functional: 30,
        framework: 20,
        architecture: 20,
        design: 15,
        quality: 10,
        reuse: 5,
      },
      minScore: 35,
      reason: 'Prefer functional fit now.',
    });
  });

  it('a stale revision (412), a refusal and a failure each say what happened', async () => {
    for (const [status, key] of [
      [412, 'kr.set.stale'],
      [403, 'ki.forbidden'],
      [422, 'kr.set.invalid'],
    ] as const) {
      mockFetch(world({ put: json(status, {}) }));
      ui();
      const card = await screen.findByLabelText(en('kr.set.title'));
      await within(card).findByText(en('kr.set.default'));
      fireEvent.change(within(card).getByLabelText(en('kr.set.reason')), {
        target: { value: 'A sufficient reason.' },
      });
      fireEvent.click(within(card).getByRole('button', { name: en('kr.set.save') }));
      expect((await within(card).findByRole('alert')).textContent).toBe(en(key));
      cleanup();
    }
  });

  it('without the publish permission the weights are read-only and there is no save', async () => {
    mockFetch(world());
    ui({ canPublish: false });
    const card = await screen.findByLabelText(en('kr.set.title'));
    await within(card).findByText(en('kr.set.default'));
    expect(
      (within(card).getByLabelText(en('kr.dimension.functional')) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(within(card).queryByRole('button', { name: en('kr.set.save') })).toBeNull();
    expect(within(card).getByText(en('kr.set.readonly'))).toBeTruthy();
    expect(within(card).getByText(en('kr.set.history.none'))).toBeTruthy();
    expect(within(card).getByText(en('kr.defaults.none'))).toBeTruthy();
  });

  it('forbidden and failed reads', async () => {
    mockFetch(world({ settings: json(403, {}) }));
    ui();
    const card = await screen.findByLabelText(en('kr.set.title'));
    expect(await within(card).findByText(en('ki.forbidden'))).toBeTruthy();
    cleanup();
    mockFetch(world({ settings: json(500, {}) }));
    ui();
    const c2 = await screen.findByLabelText(en('kr.set.title'));
    expect(await within(c2).findByRole('alert')).toBeTruthy();
    expect(within(c2).getByRole('button', { name: en('ki.retry.load') })).toBeTruthy();
  });
});

describe('KnowledgeRetrieval: Arabic', () => {
  it('renders the three sections with translated labels', async () => {
    mockFetch(world());
    ui({ locale: 'ar' });
    expect(screen.getByLabelText(t('ar', 'kr.search.title'))).toBeTruthy();
    expect(screen.getByLabelText(t('ar', 'kr.rec.title'))).toBeTruthy();
    const card = await screen.findByLabelText(t('ar', 'kr.set.title'));
    expect(await within(card).findByText(t('ar', 'kr.set.default'))).toBeTruthy();
    expect(within(card).getByLabelText(t('ar', 'kr.dimension.functional'))).toBeTruthy();
    expect(
      within(screen.getByLabelText(t('ar', 'kr.rec.title'))).getByRole('button', {
        name: t('ar', 'kr.rec.run'),
      }),
    ).toBeTruthy();
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
  });
});
