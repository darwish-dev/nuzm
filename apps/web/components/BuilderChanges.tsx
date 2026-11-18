'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Badge, Banner, Button, Card, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  PATCH_OPS,
  buildPatch,
  diffOf,
  safeText,
  type DiffView,
  type PatchErrors,
  type PatchOp,
} from '../lib/builder';
import { newKey } from '../lib/data';
import { TextArea } from './BuilderParts';
import { useBuilderCall, type Failure } from './BuilderUi';
import { Note } from './DataUi';

type Result = Schemas['ChangeResult'];

/** The files a change touched, grouped. Paths only: no file content is ever echoed back. */
export function DiffSummary({ locale, diff }: { locale: Locale; diff: DiffView }) {
  const groups: [string, string[]][] = [
    ['added', diff.added],
    ['modified', diff.modified],
    ['deleted', diff.deleted],
    ['renamed', diff.renamed.map((r) => `${r.from} → ${r.to}`)],
  ];
  const total = groups.reduce((n, [, l]) => n + l.length, 0);
  if (total === 0) return <p className="nz-muted">{t(locale, 'm10.chg.noDiff')}</p>;
  return (
    <dl>
      {groups
        .filter(([, l]) => l.length > 0)
        .map(([k, l]) => (
          <div key={k}>
            <dt>
              {t(locale, `m10.chg.diff.${k}` as 'm10.chg.diff.added')} ({l.length})
            </dt>
            <dd>
              <ul style={{ margin: 0 }}>
                {l.map((p) => (
                  <li key={p}>
                    <Ltr>{p}</Ltr>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** Field errors of a rejected change (`change_rejected`): the path and the masked reason of each. */
export function RejectedList({ locale, failure }: { locale: Locale; failure: Failure }) {
  if (failure.problem.code !== 'change_rejected' && failure.fields.length === 0) return null;
  return (
    <div role="alert">
      <p className="nz-error-text">{t(locale, 'm10.err.changeRejected')}</p>
      {failure.fields.length > 0 && (
        <ul>
          {failure.fields.map((f, i) => (
            <li key={i}>
              {f.field && <Ltr>{f.field}</Ltr>}
              {f.field && f.message ? ': ' : ''}
              {f.message && <bdi dir="auto">{f.message}</bdi>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * UI-M10-05: compose one safe-diff patch and post it to `POST …/changes` with the base version and the expected file hash. A stale base answers 409
 * `base_mismatch`; the safety checks answer 422 `change_rejected` with the path of each problem (never the content).
 */
export function ChangeComposer({
  locale,
  projectId,
  versions,
  headVersionId,
  mfaFactorId,
  prefill,
}: {
  locale: Locale;
  projectId: string;
  versions: { id: string; label?: string | null; createdAt?: string }[];
  headVersionId: string | null;
  mfaFactorId: string | null;
  prefill: { op?: string; path?: string; hash?: string };
}) {
  const router = useRouter();
  const call = useBuilderCall(locale, mfaFactorId);
  const [op, setOp] = useState<PatchOp>(
    (PATCH_OPS as readonly string[]).includes(prefill.op ?? '')
      ? (prefill.op as PatchOp)
      : 'modify',
  );
  const [path, setPath] = useState(prefill.path ?? '');
  const [from, setFrom] = useState('');
  const [content, setContent] = useState('');
  const [hash, setHash] = useState(prefill.hash ?? '');
  const [message, setMessage] = useState('');
  const [base, setBase] = useState(headVersionId ?? '');
  const [errors, setErrors] = useState<PatchErrors>({});
  const [result, setResult] = useState<Result | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [key, setKey] = useState(newKey());

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const b = buildPatch({ op, path: path.trim(), content, from: from.trim(), expectedHash: hash });
    if (!b.ok) return setErrors(b.errors);
    setErrors({});
    setMismatch(false);
    void call.run(
      () =>
        browserApi().POST('/v1/builder/projects/{projectId}/changes', {
          params: { path: { projectId }, header: { 'Idempotency-Key': key } },
          body: {
            baseVersion: base || null,
            patches: [b.patch],
            source: 'user',
            ...(message.trim() ? { message: message.trim().slice(0, 200) } : {}),
          },
        }),
      (r) => {
        setKey(newKey());
        setResult(r as Result);
        setContent(''); // a change that was applied is not kept in the form
        router.refresh();
      },
      (f) => {
        if (f.problem.code === 'base_mismatch') {
          setMismatch(true);
          setKey(newKey());
        }
        if (f.problem.code === 'change_rejected') setKey(newKey());
        // the generic notice is shown for everything but the two cases above, which have their own panels
        return f.problem.code === 'base_mismatch' || f.problem.code === 'change_rejected';
      },
    );
  }

  const err = (k: keyof PatchErrors) => (errors[k] ? t(locale, errors[k]!) : undefined);
  const diff = result ? diffOf(result.diff) : null;
  return (
    <>
      <form
        onSubmit={submit}
        noValidate
        className="nz-card"
        aria-label={t(locale, 'm10.chg.compose')}
        style={{ maxInlineSize: 720 }}
      >
        <h2 className="nz-h2">{t(locale, 'm10.chg.compose')}</h2>
        <p className="nz-muted">{t(locale, 'm10.chg.composeHelp')}</p>
        <Field id="chg-base" label={t(locale, 'm10.chg.base')} help={t(locale, 'm10.chg.baseHelp')}>
          {(x) => (
            <Select {...x} value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">{t(locale, 'm10.chg.baseNone')}</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id.slice(0, 8)}
                  {v.id === headVersionId ? ` (${t(locale, 'm10.chg.head')})` : ''}
                  {v.label ? ` · ${safeText(v.label, 40)}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="chg-op" label={t(locale, 'm10.chg.op')}>
          {(x) => (
            <Select {...x} value={op} onChange={(e) => setOp(e.target.value as PatchOp)}>
              {PATCH_OPS.map((o) => (
                <option key={o} value={o}>
                  {t(locale, `m10.chg.op.${o}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="chg-path"
          label={t(locale, 'm10.chg.path')}
          help={t(locale, 'm10.chg.pathHelp')}
          error={err('path')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={path}
              maxLength={300}
              onChange={(e) => setPath(e.target.value)}
            />
          )}
        </Field>
        {op === 'rename' && (
          <Field id="chg-from" label={t(locale, 'm10.chg.from')} error={err('from')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={from}
                maxLength={300}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
        )}
        {(op === 'add' || op === 'modify') && (
          <Field
            id="chg-content"
            label={t(locale, 'm10.chg.content')}
            help={t(locale, 'm10.chg.contentHelp')}
            error={err('content')}
          >
            {(x) => (
              <TextArea
                {...x}
                dir="ltr"
                rows={10}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            )}
          </Field>
        )}
        {op !== 'add' && (
          <Field
            id="chg-hash"
            label={t(locale, 'm10.chg.hash')}
            help={t(locale, 'm10.chg.hashHelp')}
            error={err('expectedHash')}
          >
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={hash}
                maxLength={64}
                onChange={(e) => setHash(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field id="chg-message" label={t(locale, 'm10.chg.message')}>
          {(x) => (
            <Input
              {...x}
              value={message}
              maxLength={200}
              onChange={(e) => setMessage(e.target.value)}
            />
          )}
        </Field>
        {mismatch && (
          <Banner tone="warn">
            {t(locale, 'm10.err.baseMismatch')}{' '}
            <Button variant="secondary" onClick={() => router.refresh()}>
              {t(locale, 'm10.chg.reload')}
            </Button>
          </Banner>
        )}
        {call.failure && <RejectedList locale={locale} failure={call.failure} />}
        <Note n={call.notice} />
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'm10.chg.submit')}
        </Button>
      </form>
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm10.chg.result')}
      </h2>
      {result && diff ? (
        <Card aria-label={t(locale, 'm10.chg.result')}>
          <p role="status">{t(locale, 'm10.chg.applied')}</p>
          <dl>
            <dt>{t(locale, 'm10.chg.version')}</dt>
            <dd>
              <Ltr>{result.versionId}</Ltr>
            </dd>
            <dt>{t(locale, 'm10.chg.commit')}</dt>
            <dd>
              <Ltr>{result.commit.slice(0, 12)}</Ltr> <Ltr>{result.branch}</Ltr>
            </dd>
          </dl>
          <h3 className="nz-h3">{t(locale, 'm10.chg.diff')}</h3>
          <DiffSummary locale={locale} diff={diff} />
          <h3 className="nz-h3">{t(locale, 'm10.chg.risks')}</h3>
          {result.risks.length === 0 ? (
            <p className="nz-muted">{t(locale, 'm10.chg.noRisks')}</p>
          ) : (
            <ul>
              {result.risks.map((r, i) => (
                <li key={i}>
                  <Badge tone="warn">
                    <Ltr>{safeText(r.code, 60) || '—'}</Ltr>
                  </Badge>{' '}
                  <bdi dir="auto">{safeText(r.message)}</bdi>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <p className="nz-muted">{t(locale, 'm10.chg.noResult')}</p>
      )}
      {call.panel}
    </>
  );
}
