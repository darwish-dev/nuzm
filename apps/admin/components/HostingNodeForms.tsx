'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { panelBody, panelFormOf, registerBody, type PanelForm } from '../lib/hosting-node';
import { Note, useStaffAction } from './BillingAdminPanels';

const key = () => crypto.randomUUID();

/** Register a server (a compute instance the platform owns) as a hosting node. The panel is connected next. */
export function RegisterNodeForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const [name, setName] = useState('');
  const [instance, setInstance] = useState('');
  const [err, setErr] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const r = registerBody({ name, instance });
    if (!r.ok)
      return setErr(t(locale, r.error === 'name' ? 'hnode.err.name' : 'hnode.err.instance'));
    setErr(null);
    void a.run(
      () =>
        browserApi().POST('/v1/admin/hosting/nodes', {
          params: { header: { 'Idempotency-Key': key() } },
          body: r.body,
        }),
      (d) => {
        a.setNotice({ tone: 'ok', text: t(locale, 'hnode.registered') });
        const id = (d as { node?: { id?: string } } | undefined)?.node?.id;
        if (id) router.push(`/${locale}/hosting/nodes/${id}`);
        else router.refresh();
      },
      { 422: t(locale, 'hnode.err.unknown') },
    );
  }
  return (
    <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'hnode.register')}>
      <h2 className="nz-h2">{t(locale, 'hnode.register')}</h2>
      <p className="nz-muted">{t(locale, 'hnode.register.help')}</p>
      <fieldset disabled={a.busy} className="nzc-form-grid nzc-form-grid--3">
        <Field id="hn-name" label={t(locale, 'hnode.f.name')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              maxLength={63}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field id="hn-instance" label={t(locale, 'hnode.f.instance')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              maxLength={200}
              autoComplete="off"
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
            />
          )}
        </Field>
      </fieldset>
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <Button type="submit" disabled={a.busy}>
        {t(locale, 'hnode.register.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

export interface NodeView {
  id: string;
  version: number;
  status: string;
  health: string;
  panelHost?: string | null;
  panelPort?: number | null;
  panelConfigured: boolean;
  panelTlsPinned?: boolean;
}

/** The panel connection of one server: address, port, TLS pin and the write-only access key; plus the connection test and the status actions. */
export function NodePanelForm({
  locale,
  node,
  canManage,
  mfaFactorId,
}: {
  locale: Locale;
  node: NodeView;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const [f, setF] = useState<PanelForm>(() => panelFormOf(node));
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof PanelForm>(k: K, v: PanelForm[K]) => setF((p) => ({ ...p, [k]: v }));

  function save(e: FormEvent) {
    e.preventDefault();
    const r = panelBody(f);
    if (!r.ok)
      return setErr(
        t(
          locale,
          (r.error === 'both' ? 'hnode.err.key' : `hnode.err.${r.error}`) as 'hnode.err.host',
        ),
      );
    setErr(null);
    void a.run(
      () =>
        browserApi().PUT('/v1/admin/hosting/nodes/{id}/panel', {
          params: { path: { id: node.id } },
          body: r.body as { host: string },
        }),
      () => {
        setF((p) => ({ ...p, accessKey: '', vaultRef: '' }));
        a.setNotice({ tone: 'ok', text: t(locale, 'hnode.panel.saved') });
        router.refresh();
      },
      { 422: t(locale, 'hnode.err.refused') },
    );
  }
  function test() {
    if (!node.panelConfigured) return setErr(t(locale, 'hnode.err.noPanel'));
    setErr(null);
    void a.run(
      () =>
        browserApi().POST('/v1/admin/hosting/nodes/{id}/inventory', {
          params: { path: { id: node.id } },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, 'hnode.tested') });
        router.refresh();
      },
      {
        409: t(locale, 'hnode.err.noPanel'),
        500: t(locale, 'hnode.err.test'),
        503: t(locale, 'hnode.err.test'),
      },
    );
  }
  function setStatus(status: 'active' | 'maintenance' | 'draining') {
    setErr(null);
    void a.run(
      () =>
        browserApi().PATCH('/v1/admin/hosting/nodes/{id}', {
          params: { path: { id: node.id }, header: { 'If-Match': `"${node.version}"` } },
          body: { status },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, 'hnode.changed') });
        router.refresh();
      },
      { 409: t(locale, 'hnode.err.state') },
    );
  }

  return (
    <form
      onSubmit={save}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'hnode.panel.title')}
    >
      <div className="nzc-panel-head">
        <div>
          <h2 className="nz-h2">{t(locale, 'hnode.panel.title')}</h2>
          <p className="nz-muted">{t(locale, 'hnode.panel.help')}</p>
        </div>
        <Badge tone={node.panelConfigured ? 'success' : 'warn'}>
          {node.panelConfigured ? t(locale, 'hnode.panel.ok') : t(locale, 'hnode.panel.none')}
        </Badge>
      </div>
      <fieldset disabled={!canManage || a.busy} className="nzc-form-grid nzc-form-grid--3">
        <Field id="np-host" label={t(locale, 'hnode.f.host')} help={t(locale, 'hnode.f.hostHint')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              placeholder="panel.example.com"
              autoComplete="off"
              spellCheck={false}
              value={f.host}
              onChange={(e) => set('host', e.target.value)}
            />
          )}
        </Field>
        <Field id="np-port" label={t(locale, 'hnode.f.port')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={f.port}
              onChange={(e) => set('port', e.target.value)}
            />
          )}
        </Field>
        <Field id="np-pin" label={t(locale, 'hnode.f.pin')} help={t(locale, 'hnode.f.pinHint')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              placeholder={node.panelTlsPinned ? '••• pinned' : ''}
              value={f.tlsPinSha256}
              onChange={(e) => set('tlsPinSha256', e.target.value)}
            />
          )}
        </Field>
        <Field id="np-key" label={t(locale, 'hnode.f.key')} help={t(locale, 'hnode.f.keyHint')}>
          {(x) => (
            <Input
              {...x}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={200}
              value={f.accessKey}
              onChange={(e) => set('accessKey', e.target.value)}
            />
          )}
        </Field>
        <Field id="np-vault" label={t(locale, 'hnode.f.vault')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              placeholder="vault://"
              autoComplete="off"
              spellCheck={false}
              value={f.vaultRef}
              onChange={(e) => set('vaultRef', e.target.value)}
            />
          )}
        </Field>
      </fieldset>
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <div className="nz-row">
        <Button type="submit" disabled={!canManage || a.busy}>
          {t(locale, 'hnode.panel.save')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!canManage || a.busy || !node.panelConfigured}
          onClick={test}
        >
          {t(locale, 'hnode.test')}
        </Button>
        {node.status !== 'active' && (
          <Button
            type="button"
            variant="secondary"
            disabled={!canManage || a.busy}
            onClick={() => setStatus('active')}
          >
            {t(locale, 'hnode.activate')}
          </Button>
        )}
        {node.status === 'active' && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={!canManage || a.busy}
              onClick={() => setStatus('maintenance')}
            >
              {t(locale, 'hnode.maintenance')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!canManage || a.busy}
              onClick={() => setStatus('draining')}
            >
              {t(locale, 'hnode.drain')}
            </Button>
          </>
        )}
      </div>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

export function NodeBanner({ locale, status }: { locale: Locale; status: string }) {
  return status === 'maintenance' ? (
    <Banner tone="warn">{t(locale, 'hnode.step.activate')}</Banner>
  ) : null;
}
