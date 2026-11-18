'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Select, Table } from '@nuzm/ui';
import type { ChangeResult, Diff, Page_, ProjectDetail, Version } from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { DiffView, ProblemNote, when } from './BuilderBits';
import { ConfirmDialog } from './DataUi';

const versionName = (locale: Locale, v: Version) =>
  v.label ? `#${v.seq} — ${v.label}` : t(locale, 'bld.ver.unnamed', { seq: v.seq });

/** Compare two versions: the safe diff from the older (`compareTo`) to the newer (`versionId`) one. */
export function VersionCompare({
  locale,
  projectId,
  versions,
}: {
  locale: Locale;
  projectId: string;
  versions: Version[];
}) {
  const call = useBuilderCall();
  const [from, setFrom] = useState(versions[1]?.id ?? '');
  const [to, setTo] = useState(versions[0]?.id ?? '');
  const [diff, setDiff] = useState<Diff | null>(null);
  if (versions.length < 2) return <p className="nz-muted">{t(locale, 'bld.ver.compare.need2')}</p>;
  const go = (e: FormEvent) => {
    e.preventDefault();
    setDiff(null);
    void call.run(
      () =>
        bapi.get<ProjectDetail>(`/v1/builder/projects/${projectId}`, {
          query: { versionId: to, compareTo: from },
        }),
      (d) => setDiff(d.diff ?? { structural: [], text: [] }),
    );
  };
  return (
    <section aria-labelledby="bld-cmp-h">
      <h3 className="nz-h2" id="bld-cmp-h">
        {t(locale, 'bld.ver.compare')}
      </h3>
      <form onSubmit={go} className="nz-row">
        <Field id="bld-cmp-from" label={t(locale, 'bld.ver.compare.from')}>
          {(x) => (
            <Select {...x} value={from} onChange={(e) => setFrom(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionName(locale, v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="bld-cmp-to" label={t(locale, 'bld.ver.compare.to')}>
          {(x) => (
            <Select {...x} value={to} onChange={(e) => setTo(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionName(locale, v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" disabled={call.busy || from === to}>
          {t(locale, 'bld.ver.compare.go')}
        </Button>
      </form>
      {from === to && <p className="nz-muted">{t(locale, 'bld.ver.compare.same')}</p>}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      <div aria-live="polite">{diff && <DiffView locale={locale} diff={diff} />}</div>
    </section>
  );
}

/** UI-M09-04: version history (immutable), compare, restore (a NEW head; history is never rewritten) and named snapshots of the current head. */
export function VersionsPanel({
  locale,
  projectId,
  initial,
  canWrite,
}: {
  locale: Locale;
  projectId: string;
  initial: Page_<Version>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const call = useBuilderCall();
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [target, setTarget] = useState<Version | null>(null);
  const [label, setLabel] = useState('');
  const [notice, setNotice] = useState('');
  const keys = useRef<Record<string, string>>({});
  const head = items.find((v) => v.isHead);

  const reload = async () => {
    const r = await bapi.get<Page_<Version>>(`/v1/builder/projects/${projectId}/versions`, {
      query: { limit: 50 },
    });
    if (r.response.ok && r.data) {
      setItems(r.data.items);
      setCursor(r.data.nextCursor);
    }
    router.refresh();
  };
  const more = () =>
    void call.run(
      () =>
        bapi.get<Page_<Version>>(`/v1/builder/projects/${projectId}/versions`, {
          query: { limit: 50, cursor: cursor ?? undefined },
        }),
      (p) => {
        setItems((l) => [...l, ...p.items]);
        setCursor(p.nextCursor);
      },
    );
  const restore = () => {
    if (!target) return;
    const v = target;
    keys.current[v.id] ??= newKey();
    void call.run(
      () =>
        bapi.post<{ seq: number }>(
          `/v1/builder/projects/${projectId}/versions/${v.id}/restoration`,
          {
            idempotencyKey: keys.current[v.id],
          },
        ),
      async (r) => {
        setTarget(null);
        setNotice(t(locale, 'bld.ver.restored', { from: v.seq, seq: r.seq }));
        await reload();
      },
      () => setTarget(null),
    );
  };
  const snapshot = (e: FormEvent) => {
    e.preventDefault();
    if (!head || label.trim() === '') return;
    void call.run(
      () =>
        bapi.post<ChangeResult>(`/v1/builder/projects/${projectId}/changes`, {
          body: { baseVersion: head.id, ops: [], source: 'user', label: label.trim() },
        }),
      async () => {
        setLabel('');
        setNotice(t(locale, 'bld.ver.named', { seq: head.seq }));
        await reload();
      },
    );
  };

  return (
    <>
      <p role="status" aria-live="polite">
        {notice}
      </p>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {canWrite && head && (
        <form onSubmit={snapshot} className="nz-row">
          <Field
            id="bld-snap"
            label={t(locale, 'bld.ver.snapshot')}
            help={t(locale, 'bld.ver.snapshot.help', { seq: head.seq })}
          >
            {(x) => (
              <Input
                {...x}
                maxLength={100}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={call.busy || label.trim() === ''}>
            {t(locale, 'bld.ver.snapshot.save')}
          </Button>
        </form>
      )}
      <Table
        caption={t(locale, 'bld.tab.versions')}
        rows={items}
        rowKey={(v) => v.id}
        columns={[
          {
            key: 's',
            header: t(locale, 'bld.ver.col.version'),
            render: (v) => (
              <>
                #{v.seq} {v.isHead && <Badge tone="success">{t(locale, 'bld.ver.head')}</Badge>}
              </>
            ),
          },
          {
            key: 'l',
            header: t(locale, 'bld.ver.col.label'),
            render: (v) => (v.label ? <bdi dir="auto">{v.label}</bdi> : '—'),
          },
          {
            key: 'o',
            header: t(locale, 'bld.ver.col.source'),
            render: (v) => (
              <Badge>{tDynamic(locale, `bld.ver.source.${v.source}`, v.source)}</Badge>
            ),
          },
          {
            key: 'c',
            header: t(locale, 'bld.ver.col.created'),
            render: (v) => when(v.createdAt, locale),
          },
          {
            key: 'a',
            header: t(locale, 'bld.ver.col.actions'),
            render: (v) =>
              canWrite && !v.isHead ? (
                <Button variant="secondary" disabled={call.busy} onClick={() => setTarget(v)}>
                  {t(locale, 'bld.ver.restore')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
      {cursor && (
        <Button variant="secondary" disabled={call.busy} onClick={more}>
          {t(locale, 'action.loadMore')}
        </Button>
      )}
      <VersionCompare
        key={items[0]?.id ?? 'none'}
        locale={locale}
        projectId={projectId}
        versions={items}
      />
      <ConfirmDialog
        open={target !== null}
        title={t(locale, 'bld.ver.restore.title')}
        onClose={() => setTarget(null)}
      >
        {target && (
          <>
            <p>{t(locale, 'bld.ver.restore.body', { seq: target.seq })}</p>
            <div className="nz-row">
              <Button disabled={call.busy} onClick={restore}>
                {t(locale, 'bld.ver.restore.confirm')}
              </Button>
              <Button variant="secondary" onClick={() => setTarget(null)}>
                {t(locale, 'action.cancel')}
              </Button>
            </div>
          </>
        )}
      </ConfirmDialog>
      {!canWrite && <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>}
    </>
  );
}
