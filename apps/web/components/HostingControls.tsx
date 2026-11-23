'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Ltr } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

/**
 * Website controls in the customer console (the CloudPanel-style actions): add a domain, issue a certificate, create / restore / download a backup, delete the website.
 * Every control calls the existing hosting API (which authorizes, meters, audits and reconciles); nothing here talks to a node. A node that is not connected answers
 * `unsupported_capability`, which these screens say in words instead of failing silently.
 */
const key = () => crypto.randomUUID();
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function AddDomainForm({
  locale,
  siteId,
  mfaFactorId,
}: {
  locale: Locale;
  siteId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  const [domain, setDomain] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const d = domain.trim().toLowerCase();
    if (!DOMAIN.test(d))
      return a.setNotice({ tone: 'error', text: t(locale, 'host.ctl.domain.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/hosting/sites/{id}/domains', {
          params: { path: { id: siteId }, header: { 'Idempotency-Key': key() } },
          body: { domain: d },
        }),
      () => {
        setDomain('');
        a.setNotice({ tone: 'ok', text: t(locale, 'host.ctl.domain.added') });
        router.refresh();
      },
      {
        409: t(locale, 'host.ctl.domain.inUse'),
        501: t(locale, 'host.ctl.notReady'),
        422: t(locale, 'host.ctl.domain.invalid'),
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t(locale, 'host.ctl.domain.add')}
      className="nz-card"
    >
      <h2 className="nz-h2">{t(locale, 'host.ctl.domain.add')}</h2>
      <Field id="hc-domain" label={t(locale, 'host.ctl.domain.label')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder="example.com"
            maxLength={253}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(locale, 'host.ctl.domain.submit')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

export function IssueCertificateButton({
  locale,
  siteId,
  domains,
  mfaFactorId,
}: {
  locale: Locale;
  siteId: string;
  /** the active (verified) domains of the website */
  domains: string[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  return (
    <section className="nz-card" aria-label={t(locale, 'host.ctl.ssl.issue')}>
      <h2 className="nz-h2">{t(locale, 'host.ctl.ssl.issue')}</h2>
      <p className="nz-muted">
        {t(locale, domains.length ? 'host.ctl.ssl.help' : 'host.ctl.ssl.none')}
      </p>
      <Button
        type="button"
        disabled={a.busy || domains.length === 0}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/hosting/sites/{id}/ssl-certificates', {
                params: { path: { id: siteId }, header: { 'Idempotency-Key': key() } },
                body: { mode: 'managed', domains },
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(locale, 'host.ctl.ssl.requested') });
              router.refresh();
            },
            { 422: t(locale, 'host.ctl.notReady'), 501: t(locale, 'host.ctl.notReady') },
          )
        }
      >
        {t(locale, 'host.ctl.ssl.issue')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </section>
  );
}

export function CreateBackupForm({
  locale,
  siteId,
  mfaFactorId,
}: {
  locale: Locale;
  siteId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  const [label, setLabel] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/hosting/sites/{id}/backups', {
          params: { path: { id: siteId }, header: { 'Idempotency-Key': key() } },
          body: label.trim() ? { label: label.trim() } : {},
        }),
      () => {
        setLabel('');
        a.setNotice({ tone: 'ok', text: t(locale, 'host.ctl.bk.created') });
        router.refresh();
      },
      { 422: t(locale, 'host.ctl.notReady'), 501: t(locale, 'host.ctl.notReady') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t(locale, 'host.ctl.bk.create')}
      className="nz-card"
    >
      <h2 className="nz-h2">{t(locale, 'host.ctl.bk.create')}</h2>
      <Field id="hc-bk-label" label={t(locale, 'host.ctl.bk.label')}>
        {(x) => (
          <Input {...x} maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(locale, 'host.ctl.bk.create')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

/** Per-backup actions: restore (asks first) and a short-lived download link. Only an available backup offers them. */
export function BackupRowActions({
  locale,
  siteId,
  backupId,
  available,
  canRestore,
  mfaFactorId,
}: {
  locale: Locale;
  siteId: string;
  backupId: string;
  available: boolean;
  canRestore: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  if (!available) return null;
  return (
    <span className="nz-row">
      {canRestore && (
        <Button
          type="button"
          variant="secondary"
          disabled={a.busy}
          onClick={() => {
            if (!window.confirm(t(locale, 'host.ctl.bk.restoreConfirm'))) return;
            void a.run(
              () =>
                browserApi().POST('/v1/hosting/sites/{id}/restores', {
                  params: { path: { id: siteId }, header: { 'Idempotency-Key': key() } },
                  body: { backupId },
                }),
              () => {
                a.setNotice({ tone: 'ok', text: t(locale, 'host.ctl.bk.restoring') });
                router.refresh();
              },
              { 422: t(locale, 'host.ctl.notReady'), 501: t(locale, 'host.ctl.notReady') },
            );
          }}
        >
          {t(locale, 'host.ctl.bk.restore')}
        </Button>
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/hosting/sites/{id}/backups/{backupId}/download-links', {
                params: { path: { id: siteId, backupId }, header: { 'Idempotency-Key': key() } },
              }),
            (d) => setLink(d as { url: string; expiresAt: string }),
          )
        }
      >
        {t(locale, 'host.ctl.bk.download')}
      </Button>
      {link && (
        <span role="status">
          {t(locale, 'host.ctl.bk.linkReady', { at: formatDateTime(link.expiresAt, locale) })}{' '}
          <a href={link.url}>
            <Ltr>{t(locale, 'host.ctl.bk.download')}</Ltr>
          </a>
        </span>
      )}
      <NoticeText notice={a.notice} />
      {a.panel}
    </span>
  );
}

/** Delete the website: the name must be typed (sent as X-Confirm-Delete). The API starts an export window and then a verified wipe. */
export function DeleteSiteForm({
  locale,
  siteId,
  siteName,
  mfaFactorId,
}: {
  locale: Locale;
  siteId: string;
  siteName: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  const [typed, setTyped] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (typed !== siteName)
      return a.setNotice({ tone: 'error', text: t(locale, 'host.ctl.del.mismatch') });
    void a.run(
      () =>
        browserApi().DELETE('/v1/hosting/sites/{id}', {
          params: { path: { id: siteId }, header: { 'X-Confirm-Delete': siteName } },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, 'host.ctl.del.started') });
        router.refresh();
      },
      { 422: t(locale, 'host.ctl.notReady'), 501: t(locale, 'host.ctl.notReady') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t(locale, 'host.ctl.del.title')}
      className="nz-card"
    >
      <h2 className="nz-h2">{t(locale, 'host.ctl.del.title')}</h2>
      <p className="nz-muted">{t(locale, 'host.ctl.del.help')}</p>
      <Field id="hc-del" label={t(locale, 'host.ctl.del.name')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="danger" disabled={a.busy || typed === ''}>
        {t(locale, 'host.ctl.del.submit')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}
