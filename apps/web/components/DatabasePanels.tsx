'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Badge, Banner, Button, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  ENGINES,
  VERSION_EXAMPLE,
  backupTone,
  databaseQuoteItem,
  dataError,
  formatBytes,
  ifMatch,
  inPlaceReady,
  newKey,
  offerKey,
  parseCidrs,
  positiveInt,
  restoreTone,
  shortChecksum,
  validResourceName,
  verificationOf,
  type EngineName,
} from '../lib/data';
import { ConfirmDialog, Note, useCall, type DataNotice } from './DataUi';
import { QuoteSummary, StatusBadge } from './DataParts';

type Database = Schemas['Database'];
type Backup = Schemas['DatabaseBackupWithRestores'];

/* ------------------------------------------------------------------ UI-M08-02 */

/** New database: options → price estimate (quote) → confirm. Options the service refuses stay greyed out with the reason until they change. */
export function NewDatabaseForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [engine, setEngine] = useState<EngineName>('postgresql');
  const [version, setVersion] = useState('');
  const [planRef, setPlanRef] = useState('');
  const [storageGb, setStorageGb] = useState('20');
  const [region, setRegion] = useState('');
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'private' | 'allowlist'>('private');
  const [cidrs, setCidrs] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Schemas['Quote'] | null>(null);
  const [quoted, setQuoted] = useState('');
  const [refused, setRefused] = useState<Record<string, NonNullable<DataNotice>>>({});
  const [quoteKey, setQuoteKey] = useState(newKey());
  const [createKey, setCreateKey] = useState(newKey());

  const built = databaseQuoteItem({ engine, version, planRef, storageGb, region });
  const current = built.item ? `${offerKey(built.item)}|${access}|${cidrs}` : '';
  const stale = quote !== null && quoted !== current;
  const refusal = built.item ? refused[offerKey(built.item)] : undefined;

  function validate(): Record<string, unknown> | null {
    const e: Record<string, string> = {};
    if (!validResourceName(name)) e.name = t(locale, 'm8.dbn.err.name');
    if (built.error === 'version') e.version = t(locale, 'm8.dbn.err.version');
    if (built.error === 'plan') e.plan = t(locale, 'm8.dbn.err.plan');
    if (built.error === 'storage') e.storage = t(locale, 'm8.dbn.err.storage');
    if (access === 'allowlist') {
      const c = parseCidrs(cidrs);
      if (c.error === 'open') e.cidrs = t(locale, 'm8.dbn.err.open');
      else if (c.error === 'empty') e.cidrs = t(locale, 'm8.dbn.err.cidrEmpty');
      else if (c.error) e.cidrs = t(locale, 'm8.dbn.err.cidr', { value: c.bad ?? '' });
    }
    setErrors(e);
    return Object.keys(e).length === 0 && built.item ? built.item : null;
  }

  function refuse(item: Record<string, unknown>, n: DataNotice) {
    if (n) setRefused((r) => ({ ...r, [offerKey(item)]: n }));
  }

  function estimate(ev: FormEvent) {
    ev.preventDefault();
    const item = validate();
    if (!item) return;
    setQuote(null);
    void call.run(
      () =>
        browserApi().POST('/v1/quotes', {
          params: { header: { 'Idempotency-Key': quoteKey } },
          body: { kind: 'database', items: [item] },
        }),
      (q) => {
        setQuote(q);
        setQuoted(current);
        setQuoteKey(newKey());
      },
      (p) => {
        if (
          p.code === 'unsupported_capability' ||
          p.code === 'residency_denied' ||
          p.code === 'kind_not_available'
        ) {
          const m = dataError(locale, p);
          refuse(item, { tone: 'error', text: m.text, detail: m.detail });
          return true; // shown once, as the greyed-out reason
        }
        setQuoteKey(newKey());
      },
    );
  }

  function confirm() {
    if (!quote || stale || !built.item) return;
    const item = built.item;
    const net =
      access === 'allowlist'
        ? { access: 'allowlist' as const, allowCidrs: parseCidrs(cidrs).list }
        : { access: 'private' as const };
    void call.run(
      () =>
        browserApi().POST('/v1/databases', {
          params: { header: { 'Idempotency-Key': createKey } },
          body: { quoteId: quote.id, engine, version: String(item.version), name, network: net },
        }),
      (d) => {
        setCreateKey(newKey());
        router.push(`/databases/${d.id}`);
        router.refresh();
      },
      (p) => {
        if (p.code === 'unsupported_capability' || p.code === 'residency_denied') {
          const m = dataError(locale, p);
          refuse(item, { tone: 'error', text: m.text, detail: m.detail });
          return true; // shown once, as the greyed-out reason
        }
      },
    );
  }

  return (
    <>
      <form
        onSubmit={estimate}
        noValidate
        className="nz-card"
        aria-label={t(locale, 'm8.dbn.title')}
        style={{ maxInlineSize: 640 }}
      >
        <Field
          id="dbn-name"
          label={t(locale, 'field.name')}
          help={t(locale, 'm8.dbn.nameHelp')}
          error={errors.name}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value.toLowerCase())}
            />
          )}
        </Field>
        <Field id="dbn-engine" label={t(locale, 'm8.db.col.engine')}>
          {(x) => (
            <Select {...x} value={engine} onChange={(e) => setEngine(e.target.value as EngineName)}>
              {ENGINES.map((k) => (
                <option key={k} value={k}>
                  {t(locale, `m8.engine.${k}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="dbn-version"
          label={t(locale, 'm8.db.col.version')}
          help={t(locale, 'm8.dbn.versionHelp', { example: VERSION_EXAMPLE[engine] })}
          error={errors.version}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={version}
              placeholder={VERSION_EXAMPLE[engine]}
              maxLength={20}
              onChange={(e) => setVersion(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dbn-plan"
          label={t(locale, 'm8.dbn.plan')}
          help={t(locale, 'm8.dbn.planHelp')}
          error={errors.plan}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={planRef}
              placeholder={t(locale, 'm8.dbn.planPlaceholder')}
              maxLength={100}
              onChange={(e) => setPlanRef(e.target.value)}
            />
          )}
        </Field>
        <Field id="dbn-storage" label={t(locale, 'm8.dbn.storage')} error={errors.storage}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={storageGb}
              onChange={(e) => setStorageGb(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dbn-region"
          label={t(locale, 'm8.dbn.region')}
          help={t(locale, 'm8.dbn.regionHelp')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={region}
              maxLength={60}
              onChange={(e) => setRegion(e.target.value)}
            />
          )}
        </Field>
        <Field id="dbn-net" label={t(locale, 'm8.dbn.network')}>
          {(x) => (
            <Select
              {...x}
              value={access}
              onChange={(e) => setAccess(e.target.value as 'private' | 'allowlist')}
            >
              <option value="private">{t(locale, 'm8.dbn.net.private')}</option>
              <option value="allowlist">{t(locale, 'm8.dbn.net.allowlist')}</option>
            </Select>
          )}
        </Field>
        {access === 'allowlist' && (
          <Field
            id="dbn-cidrs"
            label={t(locale, 'm8.dbn.cidrs')}
            help={t(locale, 'm8.dbn.cidrsHelp')}
            error={errors.cidrs}
          >
            {(x) => (
              <textarea
                {...x}
                className="nz-input"
                dir="ltr"
                rows={3}
                value={cidrs}
                onChange={(e) => setCidrs(e.target.value)}
              />
            )}
          </Field>
        )}
        {refusal && (
          <Banner tone="warn">
            {refusal.text}
            {refusal.detail && (
              <>
                {' '}
                <bdi dir="auto">{refusal.detail}</bdi>
              </>
            )}
          </Banner>
        )}
        <Button
          type="submit"
          disabled={call.busy || !!refusal}
          aria-describedby={refusal ? 'dbn-refused' : undefined}
        >
          {t(locale, 'm8.q.request')}
        </Button>
        {refusal && (
          <p id="dbn-refused" className="nz-muted">
            {t(locale, 'm8.dbn.greyed')}
          </p>
        )}
        {!quote && <Note n={call.notice} />}
      </form>
      {call.panel}
      {quote && (
        <>
          <QuoteSummary locale={locale} quote={quote} />
          {stale && <Banner tone="warn">{t(locale, 'm8.q.changed')}</Banner>}
          <p>
            <Button disabled={call.busy || stale} onClick={confirm}>
              {t(locale, 'm8.q.confirm')}
            </Button>
          </p>
          <Note n={call.notice} />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ UI-M08-04 */

/** Backups of one database, with restore (to a NEW database by default; in place only behind a typed confirmation) and verification history. */
export function BackupsPanel({
  locale,
  db,
  backups,
  canWrite,
  canAdmin,
  mfaFactorId,
}: {
  locale: Locale;
  db: Database;
  backups: Backup[];
  canWrite: boolean;
  canAdmin: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const create = useCall(locale, mfaFactorId);
  const restore = useCall(locale, mfaFactorId);
  const [createKey, setCreateKey] = useState(newKey());
  const [restoreKey, setRestoreKey] = useState(newKey());
  const [target, setTarget] = useState<Backup | null>(null);
  const [step, setStep] = useState<'new' | 'inplace'>('new');
  const [newName, setNewName] = useState('');
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  const close = () => {
    setTarget(null);
    setStep('new');
    setNewName('');
    setTyped('');
    setAck(false);
    setNameError(undefined);
    restore.setNotice(null);
  };
  const running = db.status === 'running';

  function makeBackup() {
    void create.run(
      () =>
        browserApi().POST('/v1/databases/{id}/backups', {
          params: { path: { id: db.id }, header: { 'Idempotency-Key': createKey } },
          body: { type: 'manual' },
        }),
      () => {
        setCreateKey(newKey());
        create.setNotice({ tone: 'ok', text: t(locale, 'm8.bk.created') });
        router.refresh();
      },
      (p) => {
        if (p.status === 409) {
          create.setNotice({ tone: 'error', text: t(locale, 'm8.bk.notRunning') });
          return true;
        }
      },
    );
  }

  function submitRestore(ev: FormEvent) {
    ev.preventDefault();
    if (!target) return;
    if (step === 'new') {
      if (!validResourceName(newName)) return setNameError(t(locale, 'm8.dbn.err.name'));
      setNameError(undefined);
    } else if (!inPlaceReady(db.name, typed, ack)) return;
    const body =
      step === 'new'
        ? { backupId: target.id, target: 'new' as const, name: newName }
        : {
            backupId: target.id,
            target: 'inplace' as const,
            confirmInPlace: true,
            confirmName: typed.trim(),
          };
    void restore.run(
      () =>
        browserApi().POST('/v1/databases/{id}/restores', {
          params: { path: { id: db.id }, header: { 'Idempotency-Key': restoreKey } },
          body,
        }),
      () => {
        setRestoreKey(newKey());
        close();
        create.setNotice({ tone: 'ok', text: t(locale, 'm8.rd.accepted') });
        router.refresh();
      },
      (p) => {
        setRestoreKey(newKey());
        if (p.status === 409 && p.code !== 'name_taken') {
          restore.setNotice({ tone: 'error', text: t(locale, 'm8.rd.conflict') });
          return true;
        }
      },
    );
  }

  const restores = backups.flatMap((b) => b.restores);
  return (
    <>
      <p className="nz-row">
        {canWrite && (
          <Button disabled={create.busy || !running} onClick={makeBackup}>
            {t(locale, 'm8.bk.create')}
          </Button>
        )}
        {!running && <span className="nz-muted">{t(locale, 'm8.bk.notRunning')}</span>}
      </p>
      <Note n={create.notice} />
      {create.panel}
      {backups.length === 0 ? (
        <div className="nz-state" role="status">
          <h2>{t(locale, 'm8.bk.empty')}</h2>
          <p>{t(locale, 'm8.bk.emptyBody')}</p>
        </div>
      ) : (
        <Table
          caption={t(locale, 'm8.bk.title')}
          rows={backups}
          rowKey={(b) => b.id}
          columns={[
            {
              key: 'c',
              header: t(locale, 'field.created'),
              icon: 'calendar',
              render: (b) => formatDateTime(b.createdAt, locale),
            },
            {
              key: 't',
              header: t(locale, 'field.type'),
              icon: 'code',
              render: (b) => tDynamic(locale, `m8.bk.type.${b.type}`, b.type),
            },
            {
              key: 's',
              header: t(locale, 'm8.bk.col.size'),
              icon: 'data',
              render: (b) => {
                const s = formatBytes(b.size);
                return s ? <Ltr>{s}</Ltr> : t(locale, 'm8.c.unavailable');
              },
            },
            {
              key: 'st',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (b) => (
                <StatusBadge
                  locale={locale}
                  prefix="m8.bk.state"
                  value={b.state}
                  tone={backupTone(b.state)}
                />
              ),
            },
            {
              key: 'e',
              header: t(locale, 'm8.bk.col.expires'),
              icon: 'calendar',
              render: (b) => (b.expiresAt ? formatDateTime(b.expiresAt, locale) : '—'),
            },
            {
              key: 'k',
              header: t(locale, 'm8.bk.col.checksum'),
              render: (b) =>
                b.checksum ? (
                  <span title={b.checksum}>
                    <Ltr>{shortChecksum(b.checksum)}</Ltr>
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'a',
              header: t(locale, 'field.action'),
              icon: 'code',
              render: (b) =>
                canAdmin && b.state === 'available' ? (
                  <Button variant="secondary" onClick={() => setTarget(b)}>
                    {t(locale, 'm8.bk.restore')}
                  </Button>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}

      <h2 className="nz-h2">{t(locale, 'm8.bk.restores')}</h2>
      {restores.length === 0 ? (
        <p className="nz-muted">{t(locale, 'm8.bk.noRestores')}</p>
      ) : (
        <Table
          caption={t(locale, 'm8.bk.restores')}
          rows={restores}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'c',
              header: t(locale, 'field.created'),
              icon: 'calendar',
              render: (r) => formatDateTime(r.createdAt, locale),
            },
            {
              key: 'm',
              header: t(locale, 'field.type'),
              icon: 'code',
              render: (r) => tDynamic(locale, `m8.rs.mode.${r.mode}`, r.mode),
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (r) => (
                <>
                  <StatusBadge
                    locale={locale}
                    prefix="m8.rs.state"
                    value={r.state}
                    tone={restoreTone(r.state)}
                  />
                  {r.state === 'failed' && (
                    <p role="alert" className="nz-error-text">
                      {r.failureCode === 'verification_mismatch'
                        ? t(locale, 'm8.rs.mismatch')
                        : t(locale, 'm8.rs.failed', { code: r.failureCode ?? '—' })}
                    </p>
                  )}
                  {r.state === 'needs_reconcile' && (
                    <p className="nz-muted">{t(locale, 'm8.rs.reconcile')}</p>
                  )}
                </>
              ),
            },
            {
              key: 'tg',
              header: t(locale, 'm8.rs.col.target'),
              render: (r) =>
                r.targetDatabaseId && r.state === 'succeeded' && r.mode === 'new' ? (
                  <a href={`/databases/${r.targetDatabaseId}`}>{t(locale, 'm8.rs.openTarget')}</a>
                ) : (
                  '—'
                ),
            },
            {
              key: 'f',
              header: t(locale, 'm8.rs.col.finished'),
              render: (r) => (r.finishedAt ? formatDateTime(r.finishedAt, locale) : '—'),
            },
          ]}
        />
      )}

      <h2 className="nz-h2">{t(locale, 'm8.bk.verification')}</h2>
      <p className="nz-muted">{t(locale, 'm8.bk.verificationHelp')}</p>
      {backups.every((b) => !verificationOf(b.lastVerification)) ? (
        <p className="nz-muted">{t(locale, 'm8.bk.noVerification')}</p>
      ) : (
        <ul>
          {backups.map((b) => {
            const v = verificationOf(b.lastVerification);
            if (!v) return null;
            return (
              <li key={b.id}>
                <Badge tone={v.passed ? 'success' : 'danger'}>
                  {v.passed ? t(locale, 'm8.bk.verified') : t(locale, 'm8.bk.mismatch')}
                </Badge>{' '}
                {t(locale, 'm8.bk.verificationLine', {
                  time: v.checkedAt ? formatDateTime(v.checkedAt, locale) : '—',
                  ok: v.tablesMatched,
                  total: v.tablesTotal,
                  created: formatDateTime(b.createdAt, locale),
                })}
                {v.passed === false && (
                  <p role="alert" className="nz-error-text">
                    {t(locale, 'm8.rs.mismatch')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={target !== null}
        onClose={close}
        title={step === 'new' ? t(locale, 'm8.rd.title') : t(locale, 'm8.rd.inplaceTitle')}
      >
        <form onSubmit={submitRestore} noValidate>
          {step === 'new' ? (
            <>
              <p>{t(locale, 'm8.rd.newHelp')}</p>
              <Field id="rd-name" label={t(locale, 'm8.rd.newName')} error={nameError}>
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    value={newName}
                    maxLength={40}
                    onChange={(e) => setNewName(e.target.value.toLowerCase())}
                  />
                )}
              </Field>
            </>
          ) : (
            <>
              <Banner tone="danger">{t(locale, 'm8.rd.inplaceWarn')}</Banner>
              <Field id="rd-typed" label={t(locale, 'm8.rd.typeName', { name: db.name })}>
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    value={typed}
                    autoComplete="off"
                    onChange={(e) => setTyped(e.target.value)}
                  />
                )}
              </Field>
              <label className="nz-row">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {t(locale, 'm8.rd.ack')}
              </label>
            </>
          )}
          <Note n={restore.notice} />
          <div className="nz-row">
            <Button
              type="submit"
              variant={step === 'new' ? 'primary' : 'danger'}
              disabled={restore.busy || (step === 'inplace' && !inPlaceReady(db.name, typed, ack))}
            >
              {step === 'new' ? t(locale, 'm8.rd.submitNew') : t(locale, 'm8.rd.submitInPlace')}
            </Button>
            <Button variant="secondary" onClick={close}>
              {t(locale, 'action.cancel')}
            </Button>
            {step === 'new' ? (
              <Button variant="secondary" onClick={() => setStep('inplace')}>
                {t(locale, 'm8.rd.switchInPlace')}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setStep('new')}>
                {t(locale, 'm8.rd.switchNew')}
              </Button>
            )}
          </div>
        </form>
        {restore.panel}
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ UI-M08-05 */

/** Backup policy, credential rotation and deletion of one database. Everything here needs `data:db:admin`; the API stays the authority. */
export function DatabaseSettings({
  locale,
  db,
  canAdmin,
  mfaFactorId,
}: {
  locale: Locale;
  db: Database;
  canAdmin: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const policy = useCall(locale, mfaFactorId);
  const rotate = useCall(locale, mfaFactorId);
  const del = useCall(locale, mfaFactorId);
  const [enabled, setEnabled] = useState(db.backupPolicy.enabled);
  const [days, setDays] = useState(String(db.backupPolicy.retentionDays));
  const [hours, setHours] = useState(String(db.backupPolicy.intervalHours));
  // the form follows the server's copy when it changes (another tab, an operation); the page does NOT remount the component for a new version, so the "saved" notice of
  // the save that caused it stays on screen (it used to vanish with the remount: the person never saw the confirmation)
  useEffect(() => {
    setEnabled(db.backupPolicy.enabled);
    setDays(String(db.backupPolicy.retentionDays));
    setHours(String(db.backupPolicy.intervalHours));
  }, [
    db.etag,
    db.backupPolicy.enabled,
    db.backupPolicy.retentionDays,
    db.backupPolicy.intervalHours,
  ]);
  const [policyError, setPolicyError] = useState<string | undefined>();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateKey, setRotateKey] = useState(newKey());
  const [rotationUnsupported, setRotationUnsupported] = useState(false);
  const [typed, setTyped] = useState('');
  const rotating = db.rotation?.state === 'pending' || db.rotation?.state === 'window';
  const rotationBlocked = rotationUnsupported || rotating || db.status !== 'running';

  function savePolicy(ev: FormEvent) {
    ev.preventDefault();
    if (!positiveInt(days, 3650) || !positiveInt(hours, 168))
      return setPolicyError(t(locale, 'm8.dbs.policyInvalid'));
    setPolicyError(undefined);
    void policy.run(
      () =>
        browserApi().PATCH('/v1/databases/{id}', {
          params: { path: { id: db.id }, header: { 'If-Match': ifMatch(db.etag) } },
          body: {
            backupPolicy: { enabled, retentionDays: Number(days), intervalHours: Number(hours) },
          },
        }),
      () => {
        policy.setNotice({ tone: 'ok', text: t(locale, 'm8.dbs.policySaved') });
        router.refresh();
      },
    );
  }

  function doRotate() {
    void rotate.run(
      () =>
        browserApi().POST('/v1/databases/{id}/credential-rotations', {
          params: { path: { id: db.id }, header: { 'Idempotency-Key': rotateKey } },
          body: {},
        }),
      () => {
        setRotateKey(newKey());
        setRotateOpen(false);
        rotate.setNotice({ tone: 'ok', text: t(locale, 'm8.dbs.rotationStarted') });
        router.refresh();
      },
      (p) => {
        setRotateOpen(false);
        if (p.code === 'unsupported_capability') {
          setRotationUnsupported(true);
          return true;
        }
      },
    );
  }

  function doDelete(ev: FormEvent) {
    ev.preventDefault();
    if (typed.trim() !== db.name) return;
    void del.run(
      () =>
        browserApi().DELETE('/v1/databases/{id}', {
          params: { path: { id: db.id }, query: { confirmName: typed.trim() } },
        }),
      () => {
        router.push(`/databases`);
        router.refresh();
      },
    );
  }

  return (
    <>
      {!canAdmin && <Banner tone="warn">{t(locale, 'm8.c.noPermission')}</Banner>}
      <form
        onSubmit={savePolicy}
        noValidate
        className="nz-card"
        aria-label={t(locale, 'm8.dbs.policy')}
        style={{ maxInlineSize: 560 }}
      >
        <h2 className="nz-h2">{t(locale, 'm8.dbs.policy')}</h2>
        <label className="nz-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canAdmin}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t(locale, 'm8.dbs.policyEnabled')}
        </label>
        <Field id="dbs-days" label={t(locale, 'm8.dbs.retention')} error={policyError}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={days}
              disabled={!canAdmin}
              onChange={(e) => setDays(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dbs-hours"
          label={t(locale, 'm8.dbs.interval')}
          help={t(locale, 'm8.dbs.policyHelp')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={hours}
              disabled={!canAdmin}
              onChange={(e) => setHours(e.target.value)}
            />
          )}
        </Field>
        {canAdmin && (
          <Button type="submit" disabled={policy.busy}>
            {t(locale, 'action.save')}
          </Button>
        )}
        <Note n={policy.notice} />
        {policy.panel}
      </form>

      <section
        className="nz-card"
        aria-label={t(locale, 'm8.dbs.rotation')}
        style={{ maxInlineSize: 560, marginBlockStart: 16 }}
      >
        <h2 className="nz-h2">{t(locale, 'm8.dbs.rotation')}</h2>
        <p>{t(locale, 'm8.dbs.rotationHelp')}</p>
        {rotationUnsupported && (
          <Banner tone="warn">{t(locale, 'm8.dbs.rotationUnsupported')}</Banner>
        )}
        {rotating && <Banner tone="warn">{t(locale, 'm8.dbs.rotationActive')}</Banner>}
        {canAdmin && (
          <Button
            variant="secondary"
            disabled={rotationBlocked || rotate.busy}
            onClick={() => setRotateOpen(true)}
          >
            {t(locale, 'm8.dbs.rotate')}
          </Button>
        )}
        <Note n={rotate.notice} />
      </section>
      <ConfirmDialog
        open={rotateOpen}
        title={t(locale, 'm8.dbs.rotate')}
        onClose={() => setRotateOpen(false)}
      >
        <p>{t(locale, 'm8.dbs.rotateConfirm')}</p>
        <div className="nz-row">
          <Button disabled={rotate.busy} onClick={doRotate}>
            {t(locale, 'action.confirm')}
          </Button>
          <Button variant="secondary" onClick={() => setRotateOpen(false)}>
            {t(locale, 'action.cancel')}
          </Button>
        </div>
        {rotate.panel}
      </ConfirmDialog>

      {canAdmin && (
        <form
          onSubmit={doDelete}
          noValidate
          className="nz-card"
          aria-label={t(locale, 'm8.dbs.delete')}
          style={{ maxInlineSize: 560, marginBlockStart: 16 }}
        >
          <h2 className="nz-h2">{t(locale, 'm8.dbs.delete')}</h2>
          <p>{t(locale, 'm8.dbs.deleteHelp')}</p>
          <Field id="dbs-confirm" label={t(locale, 'm8.dbs.typeName', { name: db.name })}>
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
          <Button type="submit" variant="danger" disabled={del.busy || typed.trim() !== db.name}>
            {t(locale, 'm8.dbs.deleteAction')}
          </Button>
          <Note n={del.notice} />
          {del.panel}
        </form>
      )}
    </>
  );
}
