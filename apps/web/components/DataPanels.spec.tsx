// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('../lib/client', () => ({
  browserApi: () => ({ POST: post, PUT: put, PATCH: patch, DELETE: del }),
}));
const ask = vi.fn();
vi.mock('./StepUp', () => ({ useStepUp: () => ({ ask, panel: null }) }));
import { DatabaseSettings, NewDatabaseForm } from './DatabasePanels';
import { RemoveSuppression } from './EmailPanels';
import { PolicyEditor, SignedUrlTool } from './StoragePanels';

const ok = (data: unknown = {}, status = 200) => ({ response: { ok: true, status }, data });
const fail = (status: number, error: unknown = {}) => ({ response: { ok: false, status }, error });
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  [post, put, patch, del, push, refresh, ask].forEach((m) => m.mockReset());
  // jsdom has no modal dialogs: the native element is emulated by the `open` attribute
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const quote = {
  id: 'q-1',
  kind: 'database',
  currency: 'SAR',
  expiresAt: '2026-12-01T00:00:00Z',
  items: [
    {
      position: 1,
      description: 'x',
      quantity: '720',
      unit: 'hour',
      unitPriceMinor: '100',
      amountMinor: '72000',
    },
  ],
  subtotalMinor: '72000',
  taxEstimate: { taxMinor: '10800' },
  totalMinor: '82800',
  requiresApproval: false,
};

describe('new database (UI-M08-02)', () => {
  function fillValid() {
    fill(t('en', 'field.name'), 'orders');
    fill(t('en', 'm8.db.col.version'), '16');
    fill(t('en', 'm8.dbn.plan'), 'plan-a');
  }
  const submit = () => fireEvent.click(button(t('en', 'm8.q.request')));

  it('quotes, then creates from the quote with an Idempotency-Key and goes to the database', async () => {
    post.mockResolvedValueOnce(ok(quote, 201)).mockResolvedValueOnce(ok({ id: 'db-1' }, 202));
    render(<NewDatabaseForm locale="en" mfaFactorId={null} />);
    fillValid();
    submit();
    expect(await screen.findByText(t('en', 'm8.q.residencyOk'))).toBeTruthy();
    const [qPath, qInit] = post.mock.calls[0]!;
    expect(qPath).toBe('/v1/quotes');
    expect(qInit.body).toEqual({
      kind: 'database',
      items: [{ engine: 'postgresql', version: '16', planRef: 'plan-a', storageGb: 20 }],
    });
    expect(qInit.params.header['Idempotency-Key']).toBeTruthy();
    fireEvent.click(button(t('en', 'm8.q.confirm')));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [cPath, cInit] = post.mock.calls[1]!;
    expect(cPath).toBe('/v1/databases');
    expect(cInit.body).toMatchObject({
      quoteId: 'q-1',
      engine: 'postgresql',
      version: '16',
      name: 'orders',
      network: { access: 'private' },
    });
    expect(cInit.params.header['Idempotency-Key']).toBeTruthy();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/databases/db-1'));
  });

  it('never calls the API for an allow-list that opens the database to the internet', () => {
    render(<NewDatabaseForm locale="en" mfaFactorId={null} />);
    fillValid();
    fill(t('en', 'm8.dbn.network'), 'allowlist');
    fill(t('en', 'm8.dbn.cidrs'), '0.0.0.0/0');
    submit();
    expect(screen.getByText(t('en', 'm8.dbn.err.open'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('greys out an offer the service refuses, with the reason, until an option changes', async () => {
    post.mockResolvedValueOnce(
      fail(422, {
        code: 'unsupported_capability',
        detail: 'version 16 is not in the supported list',
      }),
    );
    render(<NewDatabaseForm locale="en" mfaFactorId={null} />);
    fillValid();
    submit();
    expect(await screen.findByText(t('en', 'm8.err.unsupported'), { exact: false })).toBeTruthy();
    expect(
      screen.getByText('version 16 is not in the supported list', { exact: false }),
    ).toBeTruthy();
    expect((button(t('en', 'm8.q.request')) as HTMLButtonElement).disabled).toBe(true);
    fill(t('en', 'm8.db.col.version'), '17');
    expect((button(t('en', 'm8.q.request')) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a residency refusal as a plain message, not the raw reason', async () => {
    post.mockResolvedValueOnce(
      fail(403, { code: 'residency_denied', detail: 'internal policy text' }),
    );
    render(<NewDatabaseForm locale="ar" mfaFactorId={null} />);
    fill(t('ar', 'field.name'), 'orders');
    fill(t('ar', 'm8.db.col.version'), '16');
    fill(t('ar', 'm8.dbn.plan'), 'plan-a');
    fireEvent.click(button(t('ar', 'm8.q.request')));
    expect(await screen.findByText(t('ar', 'm8.err.residency'), { exact: false })).toBeTruthy();
    expect(screen.queryByText('internal policy text')).toBeNull();
  });
});

describe('database settings (UI-M08-05)', () => {
  const db = {
    id: 'db-1',
    name: 'orders',
    engine: 'postgresql',
    version: '16',
    planRef: 'p',
    status: 'running',
    endpoint: null,
    tlsRequired: true,
    network: { access: 'private' },
    dataRegion: 'r',
    providerRegionId: 'r',
    vaultRef: 'vault://x',
    backupPolicy: { enabled: true, retentionDays: 7, intervalHours: 24 },
    rotation: null,
    operationId: null,
    etag: 4,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as const;

  it('saves the backup policy with the ETag as If-Match', async () => {
    patch.mockResolvedValue(ok(db));
    render(<DatabaseSettings locale="en" db={db as never} canAdmin mfaFactorId={null} />);
    fill(t('en', 'm8.dbs.retention'), '30');
    fireEvent.click(button(t('en', 'action.save')));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, init] = patch.mock.calls[0]!;
    expect(init.params.header['If-Match']).toBe('"4"');
    expect(init.body).toEqual({
      backupPolicy: { enabled: true, retentionDays: 30, intervalHours: 24 },
    });
  });

  it('disables rotation with the reason when the provider has no dual-credential support', async () => {
    post.mockResolvedValue(fail(422, { code: 'unsupported_capability' }));
    render(<DatabaseSettings locale="en" db={db as never} canAdmin mfaFactorId={null} />);
    fireEvent.click(button(t('en', 'm8.dbs.rotate')));
    fireEvent.click(button(t('en', 'action.confirm')));
    expect(await screen.findByText(t('en', 'm8.dbs.rotationUnsupported'))).toBeTruthy();
    expect((button(t('en', 'm8.dbs.rotate')) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables rotation while one is open (409 would follow)', () => {
    const open = { ...db, rotation: { state: 'window', windowEndsAt: '2099-01-01T00:00:00Z' } };
    render(<DatabaseSettings locale="en" db={open as never} canAdmin mfaFactorId={null} />);
    expect((button(t('en', 'm8.dbs.rotate')) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t('en', 'm8.dbs.rotationActive'))).toBeTruthy();
  });

  it('deletes only after the exact name is typed and sends it as confirmName', async () => {
    del.mockResolvedValue(ok({}, 202));
    render(<DatabaseSettings locale="en" db={db as never} canAdmin mfaFactorId={null} />);
    const go = button(t('en', 'm8.dbs.deleteAction')) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fill(t('en', 'm8.dbs.typeName', { name: 'orders' }), 'order');
    expect(go.disabled).toBe(true);
    fill(t('en', 'm8.dbs.typeName', { name: 'orders' }), 'orders');
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0]![1].params.query).toEqual({ confirmName: 'orders' });
  });

  it('says a database in use cannot be deleted (409 in_use)', async () => {
    del.mockResolvedValue(fail(409, { code: 'in_use' }));
    render(<DatabaseSettings locale="en" db={db as never} canAdmin mfaFactorId={null} />);
    fill(t('en', 'm8.dbs.typeName', { name: 'orders' }), 'orders');
    fireEvent.click(button(t('en', 'm8.dbs.deleteAction')));
    expect(await screen.findByText(t('en', 'm8.err.inUse'))).toBeTruthy();
  });

  it('asks for the MFA step-up and retries when the API says so', async () => {
    del.mockResolvedValueOnce(fail(401, { code: 'step_up_required' }));
    render(<DatabaseSettings locale="en" db={db as never} canAdmin mfaFactorId="f-1" />);
    fill(t('en', 'm8.dbs.typeName', { name: 'orders' }), 'orders');
    fireEvent.click(button(t('en', 'm8.dbs.deleteAction')));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    del.mockResolvedValueOnce(ok({}, 202));
    ask.mock.calls[0]![0]();
    await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
  });
});

describe('access policy editor (UI-M08-07)', () => {
  const policy = { version: 1 as const, access: 'private' as const, statements: [], cors: [] };

  it('saves a private policy with the policy ETag and no confirmPublic', async () => {
    put.mockResolvedValue(ok({ policy, etag: 'e2', public: false }));
    render(
      <PolicyEditor
        locale="en"
        bucketId="b-1"
        policy={policy}
        etag="e1"
        canAdmin
        mfaFactorId={null}
      />,
    );
    fireEvent.click(button(t('en', 'm8.stb.savePolicy')));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, init] = put.mock.calls[0]!;
    expect(path).toBe('/v1/storage/buckets/{id}/access-policy');
    expect(init.params.header['If-Match']).toBe('"e1"');
    expect(init.body).toEqual({ policy: { version: 1, access: 'private', statements: [] } });
  });

  it('opens the warning for public-read and sends nothing until it is acknowledged', async () => {
    put.mockResolvedValue(ok({ policy, etag: 'e2', public: true }));
    render(
      <PolicyEditor
        locale="en"
        bucketId="b-1"
        policy={policy}
        etag="e1"
        canAdmin
        mfaFactorId={null}
      />,
    );
    fill(t('en', 'm8.stb.access'), 'public-read');
    fireEvent.click(button(t('en', 'm8.stb.savePolicy')));
    expect(await screen.findByText(t('en', 'm8.stb.publicTitle'))).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
    const confirm = button(t('en', 'm8.stb.publicConfirm')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(t('en', 'm8.stb.publicAck')));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![1].body).toEqual({
      policy: { version: 1, access: 'public-read', statements: [] },
      confirmPublic: true,
    });
  });

  it('retries the public change after the MFA step-up', async () => {
    put.mockResolvedValueOnce(fail(401, { code: 'step_up_required' }));
    render(
      <PolicyEditor
        locale="en"
        bucketId="b-1"
        policy={policy}
        etag="e1"
        canAdmin
        mfaFactorId="f-1"
      />,
    );
    fill(t('en', 'm8.stb.access'), 'public-read');
    fireEvent.click(button(t('en', 'm8.stb.savePolicy')));
    fireEvent.click(await screen.findByLabelText(t('en', 'm8.stb.publicAck')));
    fireEvent.click(button(t('en', 'm8.stb.publicConfirm')));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  });

  it('reports a stale policy (412) and invalid input (client side) without calling the API twice', async () => {
    put.mockResolvedValue(fail(412));
    render(
      <PolicyEditor
        locale="en"
        bucketId="b-1"
        policy={policy}
        etag="e1"
        canAdmin
        mfaFactorId={null}
      />,
    );
    fireEvent.click(button(t('en', 'm8.stb.addStatement')));
    fireEvent.click(screen.getByLabelText(t('en', 'm8.stb.action.read'))); // untick the only action
    fireEvent.click(button(t('en', 'm8.stb.savePolicy')));
    expect(screen.getByText(t('en', 'm8.stb.err.actions', { n: 1 }))).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(t('en', 'm8.stb.action.read')));
    fireEvent.click(button(t('en', 'm8.stb.savePolicy')));
    expect(await screen.findByText(t('en', 'm8.err.stale'))).toBeTruthy();
  });

  it('is read-only without data:storage:admin', () => {
    render(
      <PolicyEditor
        locale="en"
        bucketId="b-1"
        policy={policy}
        etag="e1"
        canAdmin={false}
        mfaFactorId={null}
      />,
    );
    expect(screen.queryByRole('button', { name: t('en', 'm8.stb.savePolicy') })).toBeNull();
    expect(screen.getByText(t('en', 'm8.c.noPermission'))).toBeTruthy();
  });
});

describe('signed URL tool (UI-M08-07)', () => {
  it('shows the URL once with a copy button and can clear it; the key and method are sent as typed', async () => {
    post.mockResolvedValue(
      ok(
        {
          url: 'https://files.example/o?sig=abc',
          expiresAt: '2026-12-01T00:00:00Z',
          method: 'GET',
        },
        201,
      ),
    );
    render(<SignedUrlTool locale="en" bucketId="b-1" canWrite={false} mfaFactorId={null} />);
    fill(t('en', 'm8.stb.su.key'), 'a/b.png');
    fireEvent.click(button(t('en', 'm8.stb.su.create')));
    expect(await screen.findByText('https://files.example/o?sig=abc')).toBeTruthy();
    expect(post.mock.calls[0]![1].body).toEqual({ key: 'a/b.png', method: 'GET', ttlSeconds: 900 });
    expect(screen.getByRole('button', { name: t('en', 'm8.stb.su.copy') })).toBeTruthy();
    fireEvent.click(button(t('en', 'm8.stb.su.clear')));
    expect(screen.queryByText('https://files.example/o?sig=abc')).toBeNull();
  });

  it('refuses a lifetime above 7 days before calling the API, and disables write methods without data:storage:write', () => {
    render(<SignedUrlTool locale="en" bucketId="b-1" canWrite={false} mfaFactorId={null} />);
    fill(t('en', 'm8.stb.su.key'), 'k');
    fill(t('en', 'm8.stb.su.ttl'), '604801');
    fireEvent.click(button(t('en', 'm8.stb.su.create')));
    expect(screen.getByText(t('en', 'm8.stb.su.err.ttl', { max: 604800 }))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect((screen.getByRole('option', { name: 'PUT' }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole('option', { name: 'GET' }) as HTMLOptionElement).disabled).toBe(false);
  });
});

describe('suppression removal (UI-M08-14)', () => {
  const sup = (reason: string) => ({
    id: 's-1',
    address: 'a@example.com',
    reason,
    source: 'webhook',
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    removedAt: null,
  });
  const open = () =>
    fireEvent.click(
      screen.getByRole('button', {
        name: t('en', 'm8.su.removeFor', { address: 'a@example.com' }),
      }),
    );

  it('removes a manual suppression without an override', async () => {
    post.mockResolvedValue(ok({}));
    render(
      <RemoveSuppression locale="en" suppression={sup('manual') as never} mfaFactorId={null} />,
    );
    open();
    fireEvent.click(button(t('en', 'm8.su.removeAction')));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ address: 'a@example.com', action: 'remove' });
  });

  it('needs the explicit override for a hard bounce or a complaint', async () => {
    post.mockResolvedValue(ok({}));
    render(
      <RemoveSuppression
        locale="en"
        suppression={sup('bounce_hard') as never}
        mfaFactorId={null}
      />,
    );
    open();
    const go = button(t('en', 'm8.su.removeAction')) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(t('en', 'm8.su.override')));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      address: 'a@example.com',
      action: 'remove',
      override: true,
    });
  });
});
