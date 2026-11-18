import { describe, expect, it } from 'vitest';
import { tDynamic } from '@nuzm/i18n';

const has = (key: string) => (['ar', 'en'] as const).every((l) => tDynamic(l, key, '') !== '');
import {
  EVENT_KEYS,
  TEMPLATE_IDS,
  approvalView,
  canRollback,
  cmsValue,
  createSseParser,
  credits,
  deployTone,
  draftOps,
  emptyHistory,
  eventText,
  finishRedo,
  finishUndo,
  inspectorFields,
  isBaseUrl,
  isDeployActive,
  isPreviewUrl,
  isRunActive,
  isRunFinished,
  mergeEvent,
  moveOp,
  nextRedo,
  nextSectionId,
  nextUndo,
  outlineOf,
  pageSeoOp,
  problemKey,
  problemOf,
  pushEdit,
  runTone,
  sampleSection,
  shouldReconnect,
  siteSeoOp,
  styleOf,
  toRunEvent,
  type Deployment,
  type RunEvent,
  type Section,
  type SiteModel,
  type SseFrame,
} from './builder';

const frames = (chunks: string[]): SseFrame[] => {
  const out: SseFrame[] = [];
  const p = createSseParser((f) => out.push(f));
  for (const c of chunks) p.push(c);
  return out;
};

describe('SSE frame parser', () => {
  const ev = (seq: number, type: string) =>
    `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, data: { task: 'page' }, at: '2027-01-01T00:00:00.000Z' })}\n\n`;
  it('parses complete frames and ignores retry and keep-alive comments', () => {
    const f = frames([
      'retry: 2000\n\n',
      ': keep-alive\n\n',
      ev(1, 'created'),
      ev(2, 'step_started'),
    ]);
    expect(f.map((x) => [x.id, x.event])).toEqual([
      ['1', 'created'],
      ['2', 'step_started'],
    ]);
  });
  it('reassembles a frame split at any byte boundary', () => {
    const whole = ev(7, 'artifact');
    for (let i = 1; i < whole.length; i++) {
      const f = frames([whole.slice(0, i), whole.slice(i)]);
      expect(f).toHaveLength(1);
      expect(toRunEvent(f[0]!)?.seq).toBe(7);
    }
  });
  it('accepts CRLF and joins multi-line data', () => {
    const f = frames(['id: 3\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n']);
    expect(f).toEqual([{ id: '3', event: 'x', data: 'a\nb' }]);
  });
  it('a lone CR at the end of a chunk waits for its LF', () => {
    expect(frames(['data: one\r', '\n\r', '\n'])).toEqual([{ data: 'one' }]);
  });
  it('drops malformed events instead of throwing', () => {
    expect(toRunEvent({ data: 'not json' })).toBeNull();
    expect(toRunEvent({ data: '{"seq":"1","type":"x"}' })).toBeNull();
    expect(toRunEvent({ data: '[1]' })).toBeNull();
  });
});

describe('run events and states', () => {
  const e = (seq: number, type = 'x'): RunEvent => ({ seq, type, data: {}, at: '' });
  it('merging keeps seq order and drops replays after a reconnect', () => {
    let l: RunEvent[] = [];
    for (const s of [3, 1, 2, 2, 3]) l = mergeEvent(l, e(s));
    expect(l.map((x) => x.seq)).toEqual([1, 2, 3]);
  });
  it('state classes', () => {
    expect(isRunActive('waiting_approval')).toBe(true);
    expect(isRunActive('succeeded')).toBe(false);
    expect(isRunFinished('budget_exceeded')).toBe(true);
    expect(isRunFinished('waiting_approval')).toBe(false);
    expect(runTone('failed')).toBe('danger');
    expect(runTone('waiting_approval')).toBe('warn');
  });
  it('the stream is reopened only while the run needs no human decision', () => {
    expect(shouldReconnect('running')).toBe(true);
    expect(shouldReconnect('queued')).toBe(true);
    expect(shouldReconnect('waiting_approval')).toBe(false);
    expect(shouldReconnect('cancelled')).toBe(false);
  });
  it('every known event type has a message in both languages', () => {
    for (const k of EVENT_KEYS) {
      expect(has(`bld.ev.${k}`)).toBe(true);
    }
    expect(eventText({ seq: 1, type: 'step_started', data: { task: 'page' }, at: '' })).toEqual({
      key: 'bld.ev.step_started',
      params: expect.objectContaining({ task: 'page' }),
    });
  });
  it('reads a pending approval defensively (plan pages, change-set diff and risks); the stored payload is never exposed', () => {
    const v = approvalView({
      id: 'a',
      kind: 'apply_changes',
      expiresAt: '',
      summary: {
        title: 'Apply',
        diff: {
          structural: [{ kind: 'component_changed', pageId: 'home', summary: 's' }],
          text: [],
        },
        risks: [{ code: 'deletes_page', count: 1 }],
        payload: { secret: 1 },
      },
    });
    expect(v.diff?.structural[0]?.kind).toBe('component_changed');
    expect(v.risks).toEqual([{ code: 'deletes_page', count: 1 }]);
    expect(JSON.stringify(v)).not.toContain('secret');
    expect(approvalView({ id: 'a', kind: 'plan', expiresAt: '', summary: 'weird' }).pages).toEqual(
      [],
    );
  });
});

describe('problems', () => {
  const r = (status: number, error: Record<string, unknown>) =>
    problemOf({ response: new Response(null, { status }), error });
  it('maps the wizard errors by code', () => {
    expect(problemKey(r(402, { code: 'insufficient_credits' }))).toBe(
      'bld.err.insufficient_credits',
    );
    expect(problemKey(r(403, { code: 'residency_denied' }))).toBe('bld.err.residency_denied');
    expect(problemKey(r(422, { code: 'unsupported_capability' }))).toBe(
      'bld.err.unsupported_capability',
    );
    expect(problemKey(r(503, { code: 'ai_unavailable' }))).toBe('bld.err.ai_unavailable');
    expect(problemKey(r(422, { code: 'quota_exceeded' }))).toBe('bld.err.quota_exceeded');
  });
  it('falls back by status, and 403 without a code is the generic forbidden text', () => {
    expect(problemKey(r(403, {}))).toBe('state.forbidden.title');
    expect(problemKey(r(409, {}))).toBe('bld.err.conflict');
    expect(problemKey(r(429, {}))).toBe('bld.err.rate_limited');
    expect(problemKey(r(500, {}))).toBe('state.error.title');
  });
  it('carries the rebase info, the validation issues and the approval id', () => {
    const p = r(409, { code: 'base_outdated', headVersionId: 'v9', headSeq: 9 });
    expect(p.headSeq).toBe(9);
    const q = r(422, { code: 'op_invalid', errors: [{ path: '$.x', message: 'bad' }, 3] });
    expect(q.issues).toEqual([{ path: '$.x', message: 'bad' }]);
    expect(r(403, { code: 'approval_required', approvalId: 'ap1' }).approvalId).toBe('ap1');
  });
});

const model: SiteModel = {
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  brand: { name: { ar: 'م', en: 'S' } },
  seo: { siteTitle: { ar: 'م', en: 'S' }, description: { ar: 'و', en: 'D' } },
  forms: [{ id: 'contact', name: 'Contact' }],
  pages: [
    {
      id: 'home',
      slug: 'home',
      title: { ar: 'الرئيسية', en: 'Home' },
      sections: [
        {
          id: 'hero1',
          type: 'hero',
          props: { heading: { ar: 'مرحبا', en: 'Welcome' }, subheading: { ar: 'س', en: 'sub' } },
        },
        {
          id: 'features1',
          type: 'features',
          props: {
            items: [{ title: { ar: 'أ', en: 'A' }, text: { ar: 'ب', en: 'B' }, icon: 'star' }],
          },
          style: { background: 'muted' },
        },
      ],
    },
  ],
};
const hero = model.pages[0]!.sections[0] as Section;
const feat = model.pages[0]!.sections[1] as Section;

describe('outline and inspector', () => {
  it('lists every component in reading order labelled by its heading in the page language', () => {
    const o = outlineOf(model, 'ar');
    expect(o.map((x) => x.sectionId)).toEqual(['hero1', 'features1']);
    expect(o[0]).toMatchObject({ label: 'مرحبا', pageLabel: 'الرئيسية', index: 0, count: 2 });
    expect(outlineOf(model, 'en')[0]?.label).toBe('Welcome');
  });
  it('offers one text field per site language, including item fields', () => {
    const f = inspectorFields(hero, ['ar', 'en']);
    expect(f.filter((x) => x.name === 'heading').map((x) => x.locale)).toEqual(['ar', 'en']);
    expect(f.find((x) => x.name === 'heading' && x.locale === 'en')?.initial).toBe('Welcome');
    const g = inspectorFields(feat, ['ar', 'en']);
    expect(g.some((x) => x.group === 'items.0' && x.name === 'title' && x.locale === 'ar')).toBe(
      true,
    );
    expect(g.find((x) => x.name === 'icon')?.initial).toBe('star');
  });
  it('a single-language site shows one language only', () => {
    expect(inspectorFields(hero, ['ar']).every((x) => x.locale === 'ar')).toBe(true);
  });
  it('unchanged values produce no ops', () => {
    expect(draftOps('home', hero, inspectorFields(hero, ['ar', 'en']), {}, styleOf(hero))).toEqual(
      [],
    );
  });
  it('a changed heading is one setText on that section and locale; clearing an optional text sends null', () => {
    const fields = inspectorFields(hero, ['ar', 'en']);
    const ops = draftOps(
      'home',
      hero,
      fields,
      { 'p:heading|en': 'Hello', 'p:subheading|en': '', 'p:subheading|ar': '' },
      styleOf(hero),
    );
    expect(ops).toEqual([
      {
        op: 'setText',
        target: 'section',
        pageId: 'home',
        sectionId: 'hero1',
        prop: 'heading',
        locale: 'en',
        value: 'Hello',
      },
      {
        op: 'setText',
        target: 'section',
        pageId: 'home',
        sectionId: 'hero1',
        prop: 'subheading',
        locale: 'ar',
        value: null,
      },
      {
        op: 'setText',
        target: 'section',
        pageId: 'home',
        sectionId: 'hero1',
        prop: 'subheading',
        locale: 'en',
        value: null,
      },
    ]);
  });
  it('item text and plain props go in ONE updateProps carrying the whole items list; the original is not mutated', () => {
    const fields = inspectorFields(feat, ['ar', 'en']);
    const ops = draftOps(
      'home',
      feat,
      fields,
      { 'i:0:title|en': 'Alpha', 'i:0:icon': '' },
      styleOf(feat),
    );
    expect(ops).toHaveLength(1);
    const op = ops[0] as {
      op: string;
      props: { items: { title: { en: string }; icon?: string }[] };
    };
    expect(op.op).toBe('updateProps');
    expect(op.props.items[0]?.title.en).toBe('Alpha');
    expect(op.props.items[0]).not.toHaveProperty('icon');
    expect((feat.props.items as { title: { en: string } }[])[0]?.title.en).toBe('A');
  });
  it('a style change sends the new style; clearing both choices sends null', () => {
    const ops = draftOps(
      'home',
      feat,
      inspectorFields(feat, ['ar', 'en']),
      {},
      { background: 'primary', align: 'center' },
    );
    expect(ops).toEqual([
      {
        op: 'updateProps',
        pageId: 'home',
        sectionId: 'features1',
        props: {},
        style: { background: 'primary', align: 'center' },
      },
    ]);
    const cleared = draftOps(
      'home',
      feat,
      inspectorFields(feat, ['ar', 'en']),
      {},
      { background: '', align: '' },
    );
    expect(cleared[0]).toMatchObject({ style: null });
  });
  it('builds valid sample components and unique ids; contact_form needs an existing form', () => {
    expect(nextSectionId(model, 'hero')).toBe('hero2');
    expect(nextSectionId(model, 'contact_form')).toBe('contact-form1');
    expect(sampleSection(model, 'faq', 'faq1')?.props).toHaveProperty('items');
    expect(sampleSection(model, 'contact_form', 'c1')?.props).toEqual({ formId: 'contact' });
    expect(sampleSection({ ...model, forms: [] }, 'contact_form', 'c1')).toBeNull();
    expect(moveOp('home', 'hero1', 1)).toEqual({
      op: 'moveComponent',
      pageId: 'home',
      sectionId: 'hero1',
      index: 1,
    });
  });
});

describe('undo / redo history', () => {
  const inv = (n: number) => [{ op: 'setText', n }];
  it('an edit pushes its inverse and clears redo', () => {
    let h = pushEdit(emptyHistory, inv(1));
    h = pushEdit(h, inv(2));
    expect(nextUndo(h)).toEqual(inv(2));
    expect(h.redo).toEqual([]);
  });
  it('undo moves the redo ops to the redo stack; redo moves them back; a new edit drops redo', () => {
    let h = pushEdit(pushEdit(emptyHistory, inv(1)), inv(2));
    h = finishUndo(h, inv(20));
    expect(nextUndo(h)).toEqual(inv(1));
    expect(nextRedo(h)).toEqual(inv(20));
    h = finishRedo(h, inv(2));
    expect(nextRedo(h)).toBeNull();
    expect(nextUndo(h)).toEqual(inv(2));
    h = finishUndo(h, inv(20));
    h = pushEdit(h, inv(3));
    expect(nextRedo(h)).toBeNull();
  });
  it('a failed step leaves both stacks as they were (nothing is consumed until the server accepted it)', () => {
    const h = pushEdit(emptyHistory, inv(1));
    expect(nextUndo(h)).toEqual(inv(1));
    expect(nextUndo(h)).toEqual(inv(1));
    expect(h.undo).toHaveLength(1);
  });
  it('is capped', () => {
    let h = emptyHistory;
    for (let i = 0; i < 80; i++) h = pushEdit(h, inv(i));
    expect(h.undo).toHaveLength(50);
    expect(nextUndo(h)).toEqual(inv(79));
  });
});

describe('seo ops', () => {
  it('site SEO: texts per declared language, empty address removes the base URL', () => {
    expect(
      siteSeoOp(['ar', 'en'], {
        title: { ar: ' ت ', en: 'T' },
        description: { ar: 'و', en: 'D' },
        baseUrl: '',
      }),
    ).toEqual({
      op: 'setSeo',
      seo: { siteTitle: { ar: 'ت', en: 'T' }, description: { ar: 'و', en: 'D' }, baseUrl: null },
    });
  });
  it('page SEO: everything empty means no page-level SEO (null); noindex is kept', () => {
    expect(pageSeoOp('home', ['ar', 'en'], { title: {}, description: {}, noindex: false })).toEqual(
      {
        op: 'updatePage',
        pageId: 'home',
        seo: null,
      },
    );
    expect(
      pageSeoOp('home', ['ar'], { title: { ar: 'ع' }, description: {}, noindex: true }),
    ).toEqual({
      op: 'updatePage',
      pageId: 'home',
      seo: { title: { ar: 'ع' }, noindex: true },
    });
  });
  it('base URL rule mirrors the model: absolute https only', () => {
    expect(isBaseUrl('https://www.example.com')).toBe(true);
    expect(isBaseUrl('https://example.com/ar')).toBe(true);
    for (const bad of [
      'http://example.com',
      'example.com',
      'https://',
      'https://a b.com',
      'javascript:alert(1)',
    ])
      expect(isBaseUrl(bad)).toBe(false);
  });
});

describe('deployments', () => {
  const d = (over: Partial<Deployment>): Deployment => ({
    id: 'd',
    projectId: 'p',
    versionId: 'v',
    target: {},
    environment: 'production',
    state: 'succeeded',
    operationId: null,
    artifactHash: null,
    previousDeploymentId: 'prev',
    rollbackOf: null,
    url: null,
    smoke: null,
    error: null,
    createdAt: '',
    finishedAt: null,
    ...over,
  });
  it('states', () => {
    for (const s of ['queued', 'building', 'deploying', 'smoke_checking'])
      expect(isDeployActive(s)).toBe(true);
    for (const s of ['succeeded', 'failed', 'rolled_back']) expect(isDeployActive(s)).toBe(false);
    expect(deployTone('succeeded')).toBe('success');
    expect(deployTone('rolled_back')).toBe('danger');
    expect(deployTone('building')).toBe('warn');
  });
  it('rollback only for a succeeded deployment with a predecessor that is not itself a rollback', () => {
    expect(canRollback(d({}))).toBe(true);
    expect(canRollback(d({ state: 'failed' }))).toBe(false);
    expect(canRollback(d({ previousDeploymentId: null }))).toBe(false);
    expect(canRollback(d({ rollbackOf: 'x' }))).toBe(false);
  });
  it('only http(s) URLs with a host are framed or linked', () => {
    expect(isPreviewUrl('https://abc.preview.example/ar/')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//x.y/',
      '/relative/',
      'ftp://x/y/',
    ])
      expect(isPreviewUrl(bad)).toBe(false);
  });
});

describe('misc readers', () => {
  it('credits are grouped as integer strings without float arithmetic', () => {
    expect(credits('1234567890123456789')).toBe('1,234,567,890,123,456,789');
    expect(credits(undefined)).toBe('0');
    expect(credits('x')).toBe('0');
  });
  it('typed CMS values: number, boolean, date, localized text; empty means not set', () => {
    expect(cmsValue('number', ' 12.5 ')).toBe(12.5);
    expect(cmsValue('number', 'abc')).toBeNull();
    expect(cmsValue('number', '')).toBeUndefined();
    expect(cmsValue('boolean', true)).toBe(true);
    expect(cmsValue('date', '2027-02-03')).toBe('2027-02-03');
    expect(cmsValue('date', 'nope')).toBeNull();
    expect(cmsValue('localized_text', { ar: 'م', en: ' ' })).toEqual({ ar: 'م' });
    expect(cmsValue('localized_text', { ar: '', en: '' })).toBeUndefined();
    expect(cmsValue('text', ' hi ')).toBe('hi');
  });
  it('the eight templates each have a name in both languages', () => {
    expect(TEMPLATE_IDS).toHaveLength(8);
    for (const id of TEMPLATE_IDS) {
      expect(has(`bld.tpl.${id}`)).toBe(true);
    }
  });
});
