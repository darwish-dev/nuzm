'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, EmptyState, Field, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  TEST_SUITES,
  isLiveTest,
  summaryOf,
  testTone,
  settle,
  type TestRun,
  type TestSummaryView,
} from '../lib/appbuilder';
import { newKey } from '../lib/data';
import { Word } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { Note } from './DataUi';

const POLL_MS = 3000;

/** Structured result of one run: totals, per-suite counts and every failed case with its (masked) message. */
export function TestResult({ locale, summary }: { locale: Locale; summary: TestSummaryView }) {
  return (
    <>
      <dl>
        <dt>{t(locale, 'm10.tst.totals.tests')}</dt>
        <dd>
          <Ltr>{String(summary.totals.tests)}</Ltr>
        </dd>
        <dt>{t(locale, 'm10.tst.totals.failures')}</dt>
        <dd>
          <Ltr>{String(summary.totals.failures)}</Ltr>
        </dd>
        <dt>{t(locale, 'm10.tst.totals.skipped')}</dt>
        <dd>
          <Ltr>{String(summary.totals.skipped)}</Ltr>
        </dd>
      </dl>
      {summary.note && (
        <p>
          <bdi dir="auto">{summary.note}</bdi>
        </p>
      )}
      {summary.suites.length > 0 && (
        <Table
          caption={t(locale, 'm10.tst.suites')}
          rows={summary.suites}
          rowKey={(s) => s.suite}
          columns={[
            { key: 'n', header: t(locale, 'm10.tst.suite'), render: (s) => <Ltr>{s.suite}</Ltr> },
            {
              key: 's',
              header: t(locale, 'field.status'),
              render: (s) => (
                <Badge
                  tone={
                    s.status === 'passed'
                      ? 'success'
                      : s.status === 'failed' || s.status === 'errored'
                        ? 'danger'
                        : undefined
                  }
                >
                  <Word locale={locale} prefix="m10.tst.status" value={s.status} />
                </Badge>
              ),
            },
            {
              key: 't',
              header: t(locale, 'm10.tst.totals.tests'),
              render: (s) => <Ltr>{String(s.tests)}</Ltr>,
            },
            {
              key: 'f',
              header: t(locale, 'm10.tst.totals.failures'),
              render: (s) => <Ltr>{String(s.failures)}</Ltr>,
            },
          ]}
        />
      )}
      <h3 className="nz-h3">{t(locale, 'm10.tst.failed')}</h3>
      {summary.failed.length === 0 ? (
        <p className="nz-muted">{t(locale, 'm10.tst.noFailures')}</p>
      ) : (
        <ul>
          {summary.failed.map((c, i) => (
            <li key={i}>
              <Ltr>{`${c.suite}: ${c.name}`}</Ltr>
              {c.failure && (
                <>
                  {' — '}
                  <bdi dir="auto">{c.failure}</bdi>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * UI-M10-08: test runs of a project. Each run shows the runtime that executed it (a stand-in is labelled as such), its structured results and its failed cases;
 * a run can be repeated, and a failed one handed to the AI ("ask AI to fix": a `test-fix` run).
 */
export function TestRuns({
  locale,
  projectId,
  initial,
  canTest,
  canRun,
  mfaFactorId,
}: {
  locale: Locale;
  projectId: string;
  initial: TestRun[];
  canTest: boolean;
  canRun: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useBuilderCall(locale, mfaFactorId);
  const [runs, setRuns] = useState<TestRun[]>(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [suite, setSuite] = useState<(typeof TEST_SUITES)[number]>('all');
  const [runKey, setRunKey] = useState(newKey());
  const [fixKey, setFixKey] = useState(newKey());
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const live = runs.some((r) => isLiveTest(r.status));
  useEffect(() => {
    alive.current = true;
    if (!live) return;
    const id = setTimeout(async () => {
      const r = await settle(() =>
        browserApi().GET('/v1/builder/projects/{projectId}/test-runs', {
          params: { path: { projectId } },
        }),
      );
      if (!alive.current) return;
      if (r.response.ok && r.data) {
        setOffline(false);
        setRuns((r.data as { items: TestRun[] }).items);
      } else setOffline(true);
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearTimeout(id);
      alive.current = false;
    };
  }, [live, tick]);

  function start(s: string, versionId?: string) {
    void call.run(
      () =>
        browserApi().POST('/v1/builder/projects/{projectId}/test-runs', {
          params: { path: { projectId }, header: { 'Idempotency-Key': runKey } },
          body: { suite: s as 'all', ...(versionId ? { versionId } : {}) },
        }),
      (r) => {
        setRunKey(newKey());
        const x = r as TestRun;
        setRuns((cur) => [x, ...cur.filter((c) => c.id !== x.id)]);
        setSelected(x.id);
      },
    );
  }

  function askAi(run: TestRun) {
    void call.run(
      () =>
        browserApi().POST('/v1/ai/runs', {
          params: { header: { 'Idempotency-Key': fixKey } },
          body: { kind: 'test-fix', projectId, brief: { testRunId: run.id } } as never,
        }),
      (r) => {
        setFixKey(newKey());
        router.push(`/${locale}/builder/projects/${projectId}/runs/${r.id}`);
      },
    );
  }

  const current = runs.find((r) => r.id === selected) ?? null;
  const summary = current ? summaryOf(current.summary) : null;
  return (
    <>
      {canTest && (
        <div className="nz-row">
          <Field id="tst-suite" label={t(locale, 'm10.tst.suite')}>
            {(x) => (
              <Select
                {...x}
                value={suite}
                onChange={(e) => setSuite(e.target.value as typeof suite)}
              >
                {TEST_SUITES.map((s) => (
                  <option key={s} value={s}>
                    {t(locale, `m10.tst.suite.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button disabled={call.busy} onClick={() => start(suite)}>
            {t(locale, 'm10.tst.run')}
          </Button>
        </div>
      )}
      <Note n={call.notice} />
      {offline && <Banner tone="warn">{t(locale, 'm10.err.offline')}</Banner>}
      {runs.length === 0 ? (
        <EmptyState title={t(locale, 'm10.tst.empty')} body={t(locale, 'm10.tst.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm10.tst.title')}
          rows={runs}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'id',
              header: t(locale, 'm10.tst.col.run'),
              render: (r) => (
                <button
                  type="button"
                  className="nz-btn"
                  data-variant={r.id === selected ? 'primary' : 'secondary'}
                  aria-current={r.id === selected ? 'true' : undefined}
                  onClick={() => setSelected(r.id)}
                >
                  <Ltr>{r.id.slice(0, 8)}</Ltr>
                </button>
              ),
            },
            { key: 'su', header: t(locale, 'm10.tst.suite'), render: (r) => <Ltr>{r.suite}</Ltr> },
            {
              key: 'st',
              header: t(locale, 'field.status'),
              render: (r) => (
                <Badge tone={testTone(r.status)}>
                  <Word locale={locale} prefix="m10.tst.status" value={r.status} />
                </Badge>
              ),
            },
            {
              key: 'rt',
              header: t(locale, 'm10.sbx.runtime'),
              render: (r) => <Ltr>{r.runtime?.kind ?? '—'}</Ltr>,
            },
            {
              key: 'w',
              header: t(locale, 'field.created'),
              render: (r) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
            },
          ]}
        />
      )}
      {current && summary && (
        <Card aria-label={t(locale, 'm10.tst.detail')} style={{ marginBlockStart: 16 }}>
          <h2 className="nz-h2">
            {t(locale, 'm10.tst.detail')} <Ltr>{current.id.slice(0, 8)}</Ltr>
          </h2>
          <p>
            <Badge tone={testTone(current.status)}>
              <Word locale={locale} prefix="m10.tst.status" value={current.status} />
            </Badge>{' '}
            <span className="nz-muted">{t(locale, 'm10.sbx.runtime')}: </span>
            <Badge tone="warn">
              <Ltr>{current.runtime?.kind ?? '—'}</Ltr>
            </Badge>
          </p>
          {current.runtime?.kind !== 'isolated' && (
            <Banner tone="warn">{t(locale, 'm10.sbx.notIsolated')}</Banner>
          )}
          {isLiveTest(current.status) ? (
            <p role="status">{t(locale, 'm10.tst.running')}</p>
          ) : (
            <TestResult locale={locale} summary={summary} />
          )}
          <div className="nz-row">
            {canTest && !isLiveTest(current.status) && (
              <Button
                variant="secondary"
                disabled={call.busy}
                onClick={() => start(current.suite, current.versionId)}
              >
                {t(locale, 'm10.tst.rerun')}
              </Button>
            )}
            {canRun && (current.status === 'failed' || current.status === 'errored') && (
              <Button disabled={call.busy} onClick={() => askAi(current)}>
                {t(locale, 'm10.tst.askAi')}
              </Button>
            )}
          </div>
          {(current.status === 'failed' || current.status === 'errored') && (
            <p className="nz-muted">{t(locale, 'm10.tst.askAiHelp')}</p>
          )}
        </Card>
      )}
      {call.panel}
    </>
  );
}
