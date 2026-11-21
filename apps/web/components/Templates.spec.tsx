// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { TemplateRecommend } from './TemplateRecommend';
import { TemplateStart } from './TemplateStart';
import { TemplateCards, TemplateDetail, TemplateFilters } from './Templates';
import { filtersOf, type Template } from '../lib/templates';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
const mockFetch = (h: (url: string, n: number) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, calls.length);
    }),
  );
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tpl = (o: Partial<Template> = {}): Template =>
  ({
    id: '01a1fff5-41f2-7790-b95e-5bdd710ec8ee',
    versionId: '01a1fff5-41f7-705a-9fa8-4f878d26c3e8',
    versionSeq: 2,
    name: 'Starter Dashboard',
    description: 'A dashboard starter',
    platform: 'WEB',
    frameworks: ['nextjs'],
    ownership: 'PLATFORM',
    reuse: { usages: ['FULL_STARTER', 'COMPONENTS'] },
    license: { spdx: 'MIT', verdict: 'ALLOWED' },
    capabilities: ['Authentication'],
    componentCount: 3,
    design: {
      modes: ['base', 'dark'],
      traits: { darkMode: true },
      roles: [{ role: 'primary', hex: '#2563eb' }],
      families: ['Cairo'],
      baseUnit: 4,
    },
    ...o,
  }) as Template;

describe('the gallery', () => {
  it('shows a card per template with its facts, and links to the template; no path, key or file text', () => {
    const { container } = render(
      <TemplateCards
        locale="en"
        items={[tpl()]}
        next="/en/builder/templates?cursor=c"
        filtered={false}
      />,
    );
    const card = screen.getByTestId('tpl-card');
    expect(within(card).getByRole('link', { name: 'Starter Dashboard' }).getAttribute('href')).toBe(
      '/en/builder/templates/01a1fff5-41f2-7790-b95e-5bdd710ec8ee',
    );
    expect(card.textContent).toContain('MIT');
    expect(card.textContent).toContain(t('en', 'kr.usage.FULL_STARTER'));
    expect(screen.getByRole('link', { name: t('en', 'tpl.next') }).getAttribute('href')).toBe(
      '/en/builder/templates?cursor=c',
    );
    expect(container.innerHTML).not.toMatch(/snapshots|object_key|\.tsx/);
  });
  it('says so when there is nothing, and when a filter found nothing', () => {
    render(<TemplateCards locale="ar" items={[]} next={null} filtered={false} />);
    expect(screen.getByText(t('ar', 'tpl.empty.title'))).toBeTruthy();
    cleanup();
    render(<TemplateCards locale="en" items={[]} next={null} filtered />);
    expect(screen.getByText(t('en', 'tpl.empty.filtered'))).toBeTruthy();
  });
  it('the filter form is a labelled GET search that offers "clear" only while a filter is on', () => {
    render(<TemplateFilters locale="en" f={filtersOf({})} />);
    expect(screen.getByRole('search').getAttribute('method')).toBe('get');
    expect(screen.queryByText(t('en', 'tpl.filter.clear'))).toBeNull();
    cleanup();
    render(<TemplateFilters locale="en" f={filtersOf({ q: 'x' })} />);
    expect(screen.getByText(t('en', 'tpl.filter.clear'))).toBeTruthy();
  });
});

describe('one template', () => {
  it('shows facts, capabilities and a safe design summary with colour swatches', () => {
    const { container } = render(<TemplateDetail locale="en" x={tpl()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Starter Dashboard' })).toBeTruthy();
    expect(screen.getByText('Authentication')).toBeTruthy();
    expect(screen.getByText('#2563eb')).toBeTruthy();
    expect(screen.getByText('Cairo')).toBeTruthy();
    expect(container.querySelector('.kd-chip')?.getAttribute('style')).toContain(
      'rgb(37, 99, 235)',
    );
  });
  it('handles a template with no design and no capabilities', () => {
    render(<TemplateDetail locale="en" x={tpl({ design: null, capabilities: [] })} />);
    expect(screen.getByText(t('en', 'tpl.detail.design.none'))).toBeTruthy();
    expect(screen.getByText(t('en', 'tpl.detail.capabilities.none'))).toBeTruthy();
  });
});

describe('start from a template', () => {
  const ui = (o: Partial<React.ComponentProps<typeof TemplateStart>> = {}) =>
    render(
      <TemplateStart
        locale="en"
        resourceId="r1"
        versionId="v1"
        versionSeq={2}
        templateName="Starter Dashboard"
        canWrite
        appsEnabled
        {...o}
      />,
    );
  it('a viewer or an organization without the app builder is told why, and has no form', () => {
    ui({ canWrite: false });
    expect(screen.getByText(t('en', 'tpl.start.readonly'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    ui({ appsEnabled: false });
    expect(screen.getByText(t('en', 'tpl.start.appsOff'))).toBeTruthy();
  });
  it('sends the pinned version with one key, then shows what was copied and what was skipped', async () => {
    mockFetch(() =>
      json(201, {
        project: { id: 'p1', name: 'My Dashboard', type: 'webapp' },
        license: { spdx: 'MIT' },
        files: { copied: 5, skipped: [{ path: 'docs/big.txt', reason: 'too_large' }] },
      }),
    );
    ui();
    fireEvent.change(screen.getByLabelText(t('en', 'tpl.start.name')), {
      target: { value: 'My Dashboard' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'tpl.start.mode')), {
      target: { value: 'STRICT' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.start.submit') }));
    await waitFor(() => expect(screen.getByTestId('tpl-done')).toBeTruthy());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/v1/builder/projects/from-template',
      method: 'POST',
      body: { resourceId: 'r1', versionId: 'v1', name: 'My Dashboard', adaptationMode: 'STRICT' },
    });
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText('docs/big.txt')).toBeTruthy();
    expect(screen.getByRole('link', { name: t('en', 'tpl.done.open') }).getAttribute('href')).toBe(
      '/en/builder/projects/p1',
    );
  });
  it('a refusal shows its reasons as sentences, creates nothing, and a changed input gets a new key', async () => {
    mockFetch(() =>
      json(422, {
        code: 'knowledge_template_incompatible',
        errors: [{ field: 'mode', message: 'mode_needs_starter' }],
      }),
    );
    ui();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.start.submit') }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(t('en', 'tpl.err.incompatible'));
    expect(screen.getByRole('alert').textContent).toContain(
      t('en', 'kr.reason.mode_needs_starter'),
    );
    expect(screen.queryByTestId('tpl-done')).toBeNull();
    const first = calls[0]!.headers['idempotency-key'];
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.start.submit') }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.headers['idempotency-key']).toBe(first); // a retry of the same action keeps its key
    fireEvent.change(screen.getByLabelText(t('en', 'tpl.start.mode')), {
      target: { value: 'CREATIVE' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.start.submit') }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.headers['idempotency-key']).not.toBe(first);
  });
  it('never shows raw server text or a token-like value', async () => {
    mockFetch(() => json(500, { code: 'boom', detail: 'password=hunter2', traceId: 'trace-123' }));
    ui();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.start.submit') }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).not.toContain('hunter2');
    expect(screen.getByRole('alert').textContent).toContain('trace-123');
  });
});

describe('suggest a template', () => {
  const recommendation = {
    decision: { strategy: 'AUTO_SELECT', selectedResourceId: 'r1', notes: ['auto_selected'] },
    selected: { resourceId: 'r1' },
    ranked: [
      {
        resourceId: 'r1',
        name: 'Starter Dashboard',
        score: 90.9,
        confidence: 55,
        gated: false,
        platform: 'WEB',
        usage: { recommended: 'FULL_STARTER', allowed: [] },
        dimensions: [
          { dimension: 'functional', applicable: true, score: 0.8, note: 'functional.coverage' },
          { dimension: 'design', applicable: false, score: null },
        ],
      },
      { resourceId: 'r2', name: 'Other', score: 0, confidence: 55, gated: true, dimensions: [] },
    ],
    stats: { eligible: 2, ranked: 2 },
  };
  it('needs a description or a platform before it asks', () => {
    mockFetch(() => json(200, recommendation));
    render(<TemplateRecommend locale="en" />);
    expect(
      (screen.getByRole('button', { name: t('en', 'tpl.rec.run') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('asks the API and lists the ranked templates with the reason, the best one marked', async () => {
    mockFetch(() => json(200, recommendation));
    render(<TemplateRecommend locale="en" />);
    fireEvent.change(screen.getByLabelText(t('en', 'tpl.rec.text')), {
      target: { value: 'لوحة تحكم' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.rec.run') }));
    await waitFor(() => expect(screen.getByTestId('tpl-rec-result')).toBeTruthy());
    expect(calls[0]).toMatchObject({
      url: '/v1/builder/template-recommendations',
      method: 'POST',
      body: { text: 'لوحة تحكم', mode: 'ADAPTIVE', limit: 6 },
    });
    const items = screen.getAllByTestId('tpl-rec-item');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(t('en', 'tpl.rec.best'))).toBeTruthy();
    expect(within(items[1]!).getByText(t('en', 'tpl.rec.gated'))).toBeTruthy();
    expect(items[0]!.textContent).toContain(t('en', 'kr.dimension.functional'));
    expect(items[0]!.textContent).not.toContain(t('en', 'kr.dimension.design')); // a dimension that did not apply is not listed
    expect(screen.getByText(t('en', 'kr.decision.auto_selected'))).toBeTruthy();
  });
  it('says so when nothing fits, and when the call fails', async () => {
    mockFetch(() => json(200, { ...recommendation, ranked: [], selected: null }));
    render(<TemplateRecommend locale="en" />);
    fireEvent.change(screen.getByLabelText(t('en', 'tpl.rec.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.rec.run') }));
    await waitFor(() => expect(screen.getByText(t('en', 'tpl.rec.none'))).toBeTruthy());
    mockFetch(() => json(500, {}));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'tpl.rec.run') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t('en', 'tpl.rec.error')),
    );
  });
});
