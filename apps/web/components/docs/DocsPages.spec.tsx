// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocsFrame } from '../site/DocsFrame';
import { GuideBlocks, OperationView } from './DocsParts';
import { CodeBlock } from './CodeBlock';
import { GUIDES, doc } from '../../lib/docs-content';
import { REF, opsOfTag } from '../../lib/api-docs';
import { pick } from '../../lib/site-content';

afterEach(cleanup);

describe('documentation pages', () => {
  it('the frame has the guides and every API area in its navigation, and marks the open page', () => {
    render(
      <DocsFrame
        locale="en"
        path="/docs/guides/errors"
        mode="dark"
        title="Errors"
        lead="Lead"
        toc={[
          { id: 'a', label: 'Part A' },
          { id: 'b', label: 'Part B' },
        ]}
      >
        <h2 id="a">Part A</h2>
        <h2 id="b">Part B</h2>
      </DocsFrame>,
    );
    const nav = screen.getByRole('navigation', { name: doc('docs', 'en') });
    for (const g of GUIDES)
      expect(within(nav).getByRole('link', { name: pick(g.title, 'en') })).toBeTruthy();
    for (const t of REF.tags) expect(within(nav).getByRole('link', { name: t.title })).toBeTruthy();
    const current = within(nav).getByRole('link', { current: 'page' });
    expect(current.textContent).toBe(pick(GUIDES.find((g) => g.slug === 'errors')!.title, 'en'));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('has a slim top bar only: a back arrow to the website, the logo and search (no site navigation, no footer)', () => {
    render(
      <DocsFrame locale="ar" path="/docs" mode="dark" title="x">
        <p>x</p>
      </DocsFrame>,
    );
    const top = document.querySelector('.doc-top') as HTMLElement;
    expect(
      within(top)
        .getByRole('link', { name: doc('backToSite', 'ar') })
        .getAttribute('href'),
    ).toBe('/ar');
    expect(within(top).getByRole('searchbox')).toBeTruthy();
    expect(
      within(top)
        .getByRole('link', { name: doc('docs', 'ar') })
        .getAttribute('href'),
    ).toBe('/ar/docs');
    expect(screen.queryByRole('link', { name: 'Get started' })).toBeNull();
    expect(document.querySelector('footer')).toBeNull();
    // the same page in the other language
    expect(within(top).getByRole('link', { name: 'English' }).getAttribute('href')).toBe(
      '/en/docs',
    );
  });

  it('lists the headings of the page under "On this page"', () => {
    render(
      <DocsFrame
        locale="en"
        path="/docs/guides/errors"
        mode="dark"
        title="Errors"
        toc={[
          { id: 'a', label: 'Part A' },
          { id: 'b', label: 'Part B' },
        ]}
      >
        <h2 id="a">Part A</h2>
        <h2 id="b">Part B</h2>
      </DocsFrame>,
    );
    const toc = screen.getByRole('navigation', { name: doc('onThisPage', 'en') });
    expect(
      within(toc)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['#a', '#b']);
  });

  it('asks "Was this helpful?", remembers the choice, sends it to the API (page, score, language only) and says thanks', () => {
    window.localStorage.clear();
    const send = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', send);
    render(
      <DocsFrame locale="en" path="/docs/guides/errors" mode="dark" title="Errors">
        <p>x</p>
      </DocsFrame>,
    );
    expect(screen.getByText(doc('rateQuestion', 'en'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: doc('rateGood', 'en') }));
    expect(screen.getByRole('status').textContent).toBe(doc('rateThanks', 'en'));
    expect(window.localStorage.getItem('nuzm.docs.rating:/docs/guides/errors')).toBe('good');
    expect(
      screen.getByRole('button', { name: doc('rateGood', 'en') }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('/v1/docs-feedback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      page: '/docs/guides/errors',
      score: 'good',
      locale: 'en',
    });
    vi.unstubAllGlobals();
  });

  it('a failed send never disturbs the reader: the choice stays and the thanks still shows', async () => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(
      <DocsFrame locale="ar" path="/docs" mode="dark" title="x">
        <p>x</p>
      </DocsFrame>,
    );
    fireEvent.click(screen.getByRole('button', { name: doc('rateBad', 'ar') }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByRole('status').textContent).toBe(doc('rateThanks', 'ar'));
    expect(window.localStorage.getItem('nuzm.docs.rating:/docs')).toBe('bad');
    vi.unstubAllGlobals();
  });

  it('search finds a guide and an endpoint, and says so when nothing matches', () => {
    render(
      <DocsFrame locale="en" path="/docs" mode="dark" title="x">
        <p>x</p>
      </DocsFrame>,
    );
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'idempotency' } });
    expect(
      within(screen.getByRole('list', { name: doc('searchResults', 'en') }))
        .getAllByRole('link')[0]!
        .getAttribute('href'),
    ).toBe('/en/docs/guides/idempotency');
    fireEvent.change(box, { target: { value: 'createapikey' } });
    expect(screen.getByText(doc('searchEmpty', 'en'))).toBeTruthy();
    fireEvent.change(box, { target: { value: 'api-keys' } });
    const hit = within(screen.getByRole('list', { name: doc('searchResults', 'en') })).getAllByRole(
      'link',
    )[0]!;
    expect(hit.getAttribute('href')).toMatch(/^\/en\/docs\/reference\/api-keys#/);
  });

  it('switches the page between light and dark and remembers it in a cookie', () => {
    render(
      <DocsFrame locale="en" path="/docs" mode="dark" title="x">
        <p>x</p>
      </DocsFrame>,
    );
    fireEvent.click(screen.getByRole('button', { name: doc('themeLight', 'en') }));
    expect(document.querySelector('.doc-app')!.getAttribute('data-mode')).toBe('light');
    expect(document.cookie).toContain('nuzm_theme=light');
  });

  it('shows an operation with its method, path, parameters, response, errors and samples', () => {
    const op = opsOfTag('api-keys').find((o) => o.id === 'createApiKey')!;
    render(<OperationView locale="en" op={op} />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('/v1/api-keys');
    expect(screen.getByText('POST')).toBeTruthy();
    expect(screen.getByText(doc('idem', 'en'))).toBeTruthy();
    expect(screen.getByText('scopes')).toBeTruthy();
    expect(document.body.textContent).toContain('201');
    expect(document.querySelectorAll('.doc-samples pre').length).toBe(2);
  });

  it('renders inline code and tables of a guide', () => {
    const g = GUIDES.find((x) => x.slug === 'requests')!;
    render(<GuideBlocks locale="en" blocks={g.blocks} />);
    expect(document.querySelector('table')).toBeTruthy();
    expect(document.querySelector('code')?.getAttribute('dir')).toBe('ltr');
  });

  it('lists every error code on the errors guide', () => {
    const g = GUIDES.find((x) => x.slug === 'errors')!;
    render(<GuideBlocks locale="en" blocks={g.blocks} />);
    for (const e of REF.errors) expect(screen.getByText(e.code)).toBeTruthy();
  });

  it('the copy button copies the code and says so; a refusal leaves it unchanged', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<CodeBlock code="curl x" label="cURL" copyLabel="Copy" copiedLabel="Copied" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeTruthy());
    expect(write).toHaveBeenCalledWith('curl x');
    cleanup();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    });
    render(<CodeBlock code="curl x" label="cURL" copyLabel="Copy" copiedLabel="Copied" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
  });
});
