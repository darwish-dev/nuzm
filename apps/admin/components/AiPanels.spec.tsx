// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
import { AiAdminTabs } from './AiAdminTabs';
import { AiProvidersPanel } from './AiProvidersPanel';
import { QualityPanel } from './AiQualityPanel';
import { parseQuality } from '../lib/ai';

beforeEach(() => post.mockReset());
afterEach(cleanup);

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 200 }, data });
const fail = (status: number, code?: string) => ({
  response: { ok: false, status },
  error: code ? { code } : undefined,
});
const RATE = { models: { 'm-1': { creditsPerMillionInput: '10', creditsPerMillionOutput: '30' } } };
const provider = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  code: 'acme-ai',
  adapter: 'acme',
  displayName: 'Acme AI',
  region: 'sa-central',
  dataTerms: { attested: true, retainsPrompts: false, trainsOnData: false },
  attestationRef: 'HG-09-01/ref-1',
  vaultRef: 'vault://ai/acme',
  rateCardVersion: '1',
  rateCard: RATE,
  enabled: false,
  enableRequestedBy: 'alice-id',
  enabledBy: null,
  adapterRegistered: true,
  version: 1,
  ...o,
});
const panel = (items: unknown[], o: Partial<Parameters<typeof AiProvidersPanel>[0]> = {}) =>
  render(
    <AiProvidersPanel
      locale="en"
      items={items}
      meId="bob-id"
      canManage={true}
      canApprove={true}
      mfaFactorId={null}
      {...o}
    />,
  );

describe('tabs', () => {
  it('lists the three sections and marks the current one', () => {
    render(<AiAdminTabs locale="en" current="runs" />);
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(
      screen.getByRole('link', { name: t('en', 'aia.tab.runs') }).getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('model providers (UI-M09-12)', () => {
  it('with nothing configured: the empty state names D-18 and HG-09-01 and no row exists', () => {
    panel([]);
    expect(screen.getByText(t('en', 'aia.empty'))).toBeTruthy();
    expect(screen.getByText(t('en', 'aia.emptyBody')).textContent).toMatch(/D-18.*HG-09-01/);
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('the provider form is one dense three-column grid holding all eight labelled fields', () => {
    const { container } = panel([]);
    const grid = container.querySelector('form[aria-label] .nzc-form-grid--3')!;
    expect(grid).toBeTruthy();
    expect(container.querySelector('.nzc-dense')).toBeTruthy();
    for (const key of [
      'aia.cfg.code',
      'aia.cfg.adapter',
      'aia.cfg.displayName',
      'aia.cfg.region',
      'aia.cfg.vault',
      'aia.cfg.rateVersion',
      'aia.cfg.rateCard',
      'aia.cfg.egress',
    ] as const) {
      const field = screen.getByLabelText(t('en', key));
      expect(grid.contains(field)).toBe(true);
    }
    // the rate card JSON spans two columns, so the form is three rows tall
    expect(grid.querySelector('.nzc-span-2 textarea')).toBeTruthy();
  });
  it('the credential field takes a vault reference only: no secret input exists', () => {
    const { container } = panel([]);
    // the provider setup form (under "Advanced") has no secret input; the only password field on the page is the Claude key card, which is write-only
    const setup = container.querySelector('details')!;
    expect(setup.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    const vault = screen.getByLabelText(t('en', 'aia.cfg.vault')) as HTMLInputElement;
    expect(vault.placeholder).toBe('vault://…');
    expect(vault.autocomplete).toBe('off');
  });
  it('refuses a pasted key without calling the API', () => {
    panel([]);
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set(t('en', 'aia.cfg.code'), 'acme-ai');
    set(t('en', 'aia.cfg.adapter'), 'acme');
    set(t('en', 'aia.cfg.displayName'), 'Acme AI');
    set(t('en', 'aia.cfg.region'), 'sa-central');
    set(t('en', 'aia.cfg.vault'), 'sk-live-0123456789');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'aia.cfg.err.vault'));
  });
  it('configure sends the action body with the vault reference', async () => {
    post.mockResolvedValue(ok(provider()));
    panel([]);
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set(t('en', 'aia.cfg.code'), 'acme-ai');
    set(t('en', 'aia.cfg.adapter'), 'acme');
    set(t('en', 'aia.cfg.displayName'), 'Acme AI');
    set(t('en', 'aia.cfg.region'), 'sa-central');
    set(t('en', 'aia.cfg.vault'), 'vault://ai/acme');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe('/v1/admin/ai/model-providers');
    expect(init.body).toMatchObject({
      action: 'configure',
      code: 'acme-ai',
      vaultRef: 'vault://ai/acme',
    });
  });
  describe('API key (typed here, stored sealed)', () => {
    const KEY = `test-only-${'w3Lp'.repeat(8)}`;
    const keyField = () =>
      screen.getByLabelText(t('en', 'aia.key.field'), { selector: 'input' }) as HTMLInputElement;
    it('each provider has one write-only password field: it is never filled from the server, and the screen only says whether a key is stored', () => {
      panel([provider({ vaultRef: 'vault://dev/ai-acme-ai' })]);
      expect(keyField().type).toBe('password');
      expect(keyField().value).toBe('');
      expect(keyField().autocomplete).toBe('new-password');
      expect(
        screen.getByText(t('en', 'aia.key.stored', { ref: 'vault://dev/ai-acme-ai' })),
      ).toBeTruthy();
    });
    it('a member who cannot manage providers gets no key field', () => {
      const { container } = panel([provider()], { canManage: false, canApprove: true });
      expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    });
    it('refuses a malformed key without calling the API; a good key is sent once and the field is emptied', async () => {
      post.mockResolvedValue(ok(provider({ vaultRef: 'vault://dev/ai-acme-ai' })));
      panel([provider({ vaultRef: null })]);
      fireEvent.change(keyField(), { target: { value: 'too short' } });
      fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.key.save'), hidden: true }));
      expect(post).not.toHaveBeenCalled();
      expect(screen.getByText(t('en', 'aia.key.err'))).toBeTruthy();
      fireEvent.change(keyField(), { target: { value: KEY } });
      fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.key.save'), hidden: true }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
        action: 'set_credential',
        id: 'p1',
        apiKey: KEY,
      });
      await waitFor(() => expect(keyField().value).toBe('')); // the key does not stay on the screen
      expect(document.body.textContent).not.toContain(KEY);
    });
    it('says plainly when the environment cannot store keys (production vault not decided)', async () => {
      post.mockResolvedValue(fail(422, 'unsupported_capability'));
      panel([provider({ vaultRef: null })]);
      fireEvent.change(keyField(), { target: { value: KEY } });
      fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.key.save'), hidden: true }));
      expect(await screen.findByText(t('en', 'aia.key.unavailable'))).toBeTruthy();
    });
    it('removing the key is one POST with the provider id', async () => {
      post.mockResolvedValue(ok(provider({ vaultRef: null })));
      panel([provider({ vaultRef: 'vault://dev/ai-acme-ai' })]);
      fireEvent.click(
        screen.getByRole('button', { name: t('en', 'aia.key.remove'), hidden: true }),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
        action: 'clear_credential',
        id: 'p1',
      });
    });
  });
  describe('Claude key: one field on top, the rest under "Advanced"', () => {
    const KEY = `test-only-${'h5Xd'.repeat(8)}`;
    const claudeField = () =>
      screen.getByLabelText(t('en', 'aia.claude.field'), { selector: 'input' }) as HTMLInputElement;
    it('shows a single write-only field first; the provider setup form sits inside a collapsed "Advanced" section', () => {
      const { container } = panel([]);
      expect(claudeField().type).toBe('password');
      expect(claudeField().value).toBe('');
      expect(screen.getByText(t('en', 'aia.claude.none'))).toBeTruthy();
      const adv = container.querySelector('details')!;
      expect(adv.open).toBe(false);
      expect(adv.textContent).toContain(t('en', 'aia.advanced'));
      expect(adv.querySelector('form')).toBeTruthy(); // the long form is in there, not on the page
    });
    it('sends only { action, apiKey }, then empties the field and does not keep the key on the screen', async () => {
      post.mockResolvedValue(ok(provider({ code: 'claude', vaultRef: 'vault://dev/ai-claude' })));
      panel([]);
      fireEvent.change(claudeField(), { target: { value: 'too short' } });
      fireEvent.click(
        screen.getByRole('button', { name: t('en', 'aia.claude.save'), hidden: true }),
      );
      expect(post).not.toHaveBeenCalled();
      expect(screen.getByText(t('en', 'aia.key.err'))).toBeTruthy();
      fireEvent.change(claudeField(), { target: { value: KEY } });
      fireEvent.click(
        screen.getByRole('button', { name: t('en', 'aia.claude.save'), hidden: true }),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
        action: 'save_claude_key',
        apiKey: KEY,
      });
      await waitFor(() => expect(claudeField().value).toBe(''));
      expect(document.body.textContent).not.toContain(KEY);
    });
    it('says a key is stored when the claude provider has one, and offers to remove it', async () => {
      post.mockResolvedValue(ok(provider({ code: 'claude', vaultRef: null })));
      panel([
        provider({
          id: 'c1',
          code: 'claude',
          adapter: 'anthropic',
          vaultRef: 'vault://dev/ai-claude',
        }),
      ]);
      expect(screen.getByText(t('en', 'aia.claude.stored'))).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: t('en', 'aia.claude.remove'), hidden: true }),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
        action: 'clear_credential',
        id: 'c1',
      });
    });
    it('asks for a fresh two-factor code when needed, answers it without leaving the page, and then saves the key', async () => {
      const submits: boolean[] = [];
      const onSubmit = (e: Event) => submits.push(e.defaultPrevented);
      document.addEventListener('submit', onSubmit);
      let saves = 0;
      post.mockImplementation(async (url: string) => {
        if (String(url).includes('/verification')) return ok({});
        saves += 1;
        return saves === 1
          ? fail(403, 'step_up_required')
          : ok(provider({ code: 'claude', vaultRef: 'vault://dev/ai-claude' }));
      });
      try {
        const { container } = panel([], { mfaFactorId: 'f1' });
        fireEvent.change(claudeField(), { target: { value: KEY } });
        fireEvent.click(
          screen.getByRole('button', { name: t('en', 'aia.claude.save'), hidden: true }),
        );
        const code = (await screen.findByLabelText(t('en', 'field.code'))) as HTMLInputElement;
        // the challenge is its own form: never nested inside the key form (a form inside a form is invalid HTML)
        expect(container.querySelector('form form')).toBeNull();
        fireEvent.change(code, { target: { value: '123456' } });
        fireEvent.click(
          screen.getByRole('button', { name: t('en', 'action.verify'), hidden: true }),
        );
        await waitFor(() => expect(saves).toBe(2)); // the original save was retried after the code was accepted
        expect(submits.length).toBeGreaterThan(0);
        expect(submits.every(Boolean)).toBe(true); // every submit was handled by the page, none left to the browser (a native submit would reload with ?code=)
        expect(
          post.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('verification')),
        ).toHaveLength(1); // one code check, one retry
        await waitFor(() => expect(claudeField().value).toBe(''));
      } finally {
        document.removeEventListener('submit', onSubmit);
      }
    });
    describe('Test connection', () => {
      const claudeRow = () =>
        provider({
          id: 'c1',
          code: 'claude',
          adapter: 'anthropic',
          vaultRef: 'vault://dev/ai-claude',
        });
      const testBtn = () =>
        screen.getByRole('button', { name: t('en', 'aia.test.button'), hidden: true });
      it('is offered only when a key is stored', () => {
        panel([]);
        expect(
          screen.queryByRole('button', { name: t('en', 'aia.test.button'), hidden: true }),
        ).toBeNull();
        cleanup();
        panel([claudeRow()]);
        expect(testBtn()).toBeTruthy();
      });
      it('posts to the provider connection-test route with no key in the request, and says the connection works', async () => {
        post.mockResolvedValue(ok({ outcome: 'ok', httpStatus: 200, modelCount: 7, live: true }));
        panel([claudeRow()]);
        fireEvent.click(testBtn());
        await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
        const [path, init] = post.mock.calls[0] as [string, { params?: unknown; body?: unknown }];
        expect(path).toBe('/v1/admin/ai/model-providers/{id}/connection-test');
        expect(init.params).toEqual({ path: { id: 'c1' } });
        expect(init.body).toBeUndefined(); // the server reads the key from its store
        expect(await screen.findByText(t('en', 'aia.test.ok', { n: 7, status: '' }))).toBeTruthy();
      });
      it.each([
        ['invalid_key', 401],
        ['forbidden', 403],
        ['rate_limited', 429],
        ['unreachable', undefined],
      ] as const)('says plainly what %s means', async (outcome, httpStatus) => {
        post.mockResolvedValue(ok({ outcome, httpStatus, live: true }));
        panel([claudeRow()]);
        fireEvent.click(testBtn());
        expect(
          await screen.findByText(t('en', `aia.test.${outcome}`, { n: 0, status: '' })),
        ).toBeTruthy();
      });
      it('a production profile or a missing key (422) says testing is unavailable here', async () => {
        post.mockResolvedValue(fail(422, 'unsupported_capability'));
        panel([claudeRow()]);
        fireEvent.click(testBtn());
        expect(await screen.findByText(t('en', 'aia.test.unavailable'))).toBeTruthy();
      });
      it('a result is dropped when the key is replaced', async () => {
        post.mockResolvedValueOnce(
          ok({ outcome: 'ok', httpStatus: 200, modelCount: 3, live: true }),
        );
        panel([claudeRow()]);
        fireEvent.click(testBtn());
        await screen.findByText(t('en', 'aia.test.ok', { n: 3, status: '' }));
        post.mockResolvedValueOnce(
          ok(provider({ code: 'claude', vaultRef: 'vault://dev/ai-claude' })),
        );
        fireEvent.change(claudeField(), { target: { value: KEY } });
        fireEvent.click(
          screen.getByRole('button', { name: t('en', 'aia.claude.save'), hidden: true }),
        );
        await waitFor(() =>
          expect(screen.queryByText(t('en', 'aia.test.ok', { n: 3, status: '' }))).toBeNull(),
        );
      });
    });
    it('a member who cannot manage providers sees no field', () => {
      panel([], { canManage: false, canApprove: true });
      expect(
        screen.queryByLabelText(t('en', 'aia.claude.field'), { selector: 'input' }),
      ).toBeNull();
    });
  });
  it('a row shows the attestation, vault reference and rate card, and the enabling blockers when unattested', () => {
    panel([provider({ dataTerms: { attested: false }, attestationRef: null })]);
    expect(screen.getByText(t('en', 'aia.notAttested'))).toBeTruthy();
    expect(screen.getByText('vault://ai/acme')).toBeTruthy();
    expect(screen.getByText(t('en', 'aia.blocker.not_attested'))).toBeTruthy();
    expect(
      screen.getByRole('button', { name: t('en', 'aia.enable'), hidden: true }),
    ).toHaveProperty('disabled', true);
  });
  it('two-person rule: the person who requested enabling cannot enable, and is told why', () => {
    panel([provider({ enableRequestedBy: 'me-id' })], { meId: 'me-id' });
    const btn = screen.getByRole('button', { name: t('en', 'aia.enable'), hidden: true });
    expect(btn).toHaveProperty('disabled', true);
    expect(screen.getByText(t('en', 'aia.enable.twoPerson'))).toBeTruthy();
  });
  it('a different person can enable; the action is a single POST with the provider id', async () => {
    post.mockResolvedValue(ok(provider({ enabled: true })));
    panel([provider()]);
    const btn = screen.getByRole('button', { name: t('en', 'aia.enable'), hidden: true });
    expect(btn).toHaveProperty('disabled', false);
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
      action: 'enable',
      id: 'p1',
    });
  });
  it('an API refusal of the second-person rule (403) is explained', async () => {
    post.mockResolvedValue(fail(403, 'forbidden'));
    panel([provider()]);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.enable'), hidden: true }));
    await waitFor(() => expect(screen.getByText(t('en', 'aia.err.forbidden'))).toBeTruthy());
  });
  it('without the approve permission, enabling and attesting are not offered', () => {
    panel([provider()], { canApprove: false });
    expect(
      screen.getByRole('button', { name: t('en', 'aia.enable'), hidden: true }),
    ).toHaveProperty('disabled', true);
    expect(screen.queryByRole('form', { name: t('en', 'aia.att.title') })).toBeNull();
  });
  it('read-only staff see rows but no configure form and no kill switch', () => {
    panel([provider()], { canManage: false, canApprove: false });
    expect(screen.queryByLabelText(t('en', 'aia.cfg.vault'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('en', 'aia.ks.engage') })).toBeNull();
  });
  it('attestation sends the reference and an explicit answer for each term', async () => {
    post.mockResolvedValue(ok(provider()));
    panel([provider({ dataTerms: { attested: false }, attestationRef: null })]);
    fireEvent.change(screen.getByLabelText(t('en', 'aia.att.ref'), { selector: '#att-ref-p1' }), {
      target: { value: 'HG-09-01/ref-9' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'aia.att.retains')), {
      target: { value: 'false' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'aia.att.trains')), {
      target: { value: 'unknown' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.att.submit'), hidden: true }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
      action: 'attest',
      id: 'p1',
      attestationRef: 'HG-09-01/ref-9',
      dataTerms: { retainsPrompts: false, trainsOnData: 'unknown' },
    });
  });
});

describe('global kill switch', () => {
  it('asks for confirmation before sending anything, and cancel sends nothing', () => {
    panel([]);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.ks.engage') }));
    expect(post).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: t('en', 'aia.ks.confirmTitle') });
    expect(within(group).getByText(t('en', 'aia.ks.confirm.on.global'))).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: t('en', 'action.cancel') }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: t('en', 'aia.ks.confirmTitle') })).toBeNull();
  });
  it('confirmed: one global kill_switch action, and the result is shown', async () => {
    post.mockResolvedValue(ok({ killSwitch: true, scope: 'global' }));
    panel([]);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.ks.engage') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.ks.confirmOn') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
      action: 'kill_switch',
      on: true,
    });
    await waitFor(() => expect(screen.getByText(t('en', 'aia.ks.last.on.global'))).toBeTruthy());
  });
  it('an organization id that is not valid is refused before any confirmation', () => {
    panel([]);
    fireEvent.change(screen.getByLabelText(t('en', 'aia.ks.org')), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aia.ks.engage') }));
    expect(screen.queryByRole('group', { name: t('en', 'aia.ks.confirmTitle') })).toBeNull();
    expect(screen.getByText(t('en', 'aia.ks.orgInvalid'))).toBeTruthy();
  });
});

describe('quality panel (UI-M09-14)', () => {
  const quality = parseQuality({
    thresholds: { htmlErrorFreeSites: 0.95, a11yScore: 90 },
    reports: [
      {
        id: 'r2',
        createdAt: '2027-02-01T00:00:00Z',
        model: 'mock-model',
        modelQuality: 'NOT VERIFIED',
        sites: 40,
        metrics: { htmlErrorFreeSites: 1, requirementCoverage: 0.85 },
        breaches: ['requirementCoverage'],
      },
      {
        id: 'r1',
        createdAt: '2027-01-01T00:00:00Z',
        model: 'mock-model',
        modelQuality: 'NOT VERIFIED',
        sites: 40,
        metrics: { htmlErrorFreeSites: 0.9, requirementCoverage: 0.9 },
        breaches: [],
      },
    ],
  });
  it('shows the breach warning, the NOT VERIFIED stamp, the delta and a text breach marker', () => {
    render(<QualityPanel locale="en" quality={quality} />);
    expect(screen.getByText(t('en', 'aia.quality.breach'))).toBeTruthy();
    expect(screen.getAllByText(t('en', 'aia.quality.notVerified'))).toHaveLength(2);
    expect(screen.getAllByText(t('en', 'aia.quality.breached'))).toHaveLength(1);
    expect(screen.getByText('+0.1')).toBeTruthy();
    // the human rubric is never filled in by the harness
    expect(screen.getAllByText(t('en', 'aia.quality.rubricPending'))).toHaveLength(2);
  });
  it('a metric that was not measured is "not measured", never zero', () => {
    render(<QualityPanel locale="en" quality={quality} />);
    expect(screen.getAllByText(t('en', 'aia.quality.notMeasured')).length).toBeGreaterThan(0);
    expect(screen.queryByText('0')).toBeNull();
  });
  it('without breaches it says so', () => {
    render(
      <QualityPanel
        locale="ar"
        quality={{ thresholds: {}, reports: [{ ...quality.reports[1]! }] }}
      />,
    );
    expect(screen.getByText(t('ar', 'aia.quality.noBreach'))).toBeTruthy();
  });
});
