'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Banner, Button, Field, Input, Meter, Select } from '@nuzm/ui';
import { adminCsrf } from '../lib/client';
import { PLATFORMS, RESOURCE_TYPES, formatBytes, splitList } from '../lib/knowledge';
import {
  ACCEPTED_SUFFIXES,
  UploadError,
  cancelUpload,
  checkFile,
  runUpload,
  type UploadDeps,
  type UploadErrorCode,
  type UploadProgress,
} from '../lib/knowledge-upload';

const browserDeps = (): UploadDeps => ({
  fetch: (...a) => window.fetch(...a),
  csrf: adminCsrf,
  store: (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined; // storage can be blocked: the upload still works, it just cannot be resumed after a reload
    }
  })(),
});

type State =
  | { kind: 'idle' }
  | { kind: 'running'; progress: UploadProgress }
  | { kind: 'done'; resourceId: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: UploadErrorCode };

/**
 * Upload panel of the knowledge library (SCR-K-01). A file is checked, hashed in the browser, and sent in verified parts that can be resumed after an
 * interruption (choose the same file again). Cancel discards the parts on the server. The package is quarantined afterwards: nothing in it is opened here.
 * With `resource` it adds a new version of that resource instead of creating one.
 */
export function KnowledgeUpload({
  locale,
  resource,
}: {
  locale: Locale;
  resource?: { id: string; name: string; resourceType: string };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [over, setOver] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const session = useRef<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const running = state.kind === 'running';

  const choose = (f: File | null | undefined) => {
    setState({ kind: 'idle' });
    setFile(null);
    setFileError(null);
    if (!f) return;
    try {
      checkFile(f);
      setFile(f);
    } catch (e) {
      setFileError(
        t(locale, (e as UploadError).code === 'size' ? 'kn.up.err.size' : 'kn.up.err.type'),
      );
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!running) choose(e.dataTransfer.files[0]);
  };

  async function start() {
    const f = form.current;
    if (!f || !file) return setFileError(t(locale, 'kn.up.err.file'));
    const v = (n: string) =>
      String((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
    const name = resource ? resource.name : v('name');
    if (!name) return setNameError(t(locale, 'kn.up.err.name'));
    setNameError(null);
    ctl.current = new AbortController();
    setState({ kind: 'running', progress: { phase: 'hashing', percent: 0 } });
    try {
      const r = await runUpload({
        file,
        resourceId: resource?.id,
        metadata: {
          name,
          resourceType: resource ? resource.resourceType : v('resourceType') || 'THEME',
          ...(v('platform') ? { platform: v('platform') } : {}),
          ...(v('description') ? { description: v('description') } : {}),
          ...(v('category') ? { category: v('category') } : {}),
          ...(v('license') ? { license: v('license') } : {}),
          frameworks: splitList(v('frameworks')),
          languages: splitList(v('languages')),
          tags: splitList(v('tags')),
        },
        deps: browserDeps(),
        signal: ctl.current.signal,
        onSession: (id) => (session.current = id),
        onProgress: (progress) => setState({ kind: 'running', progress }),
      });
      setState({ kind: 'done', resourceId: r.resourceId });
      router.refresh();
    } catch (e) {
      const code = e instanceof UploadError ? e.code : 'generic';
      if (code === 'aborted') return; // cancel() has already set the state
      setState({ kind: 'error', code });
    }
  }
  async function cancel() {
    ctl.current?.abort();
    const id = session.current;
    session.current = null;
    if (id) await cancelUpload(id, browserDeps()).catch(() => undefined);
    setState({ kind: 'cancelled' });
  }

  const progressText = (p: UploadProgress) =>
    p.phase === 'hashing'
      ? t(locale, 'kn.up.hashing', { percent: String(p.percent) })
      : p.phase === 'sending'
        ? t(locale, 'kn.up.sending', {
            done: String(Math.min(p.done + 1, p.total)),
            total: String(p.total),
          })
        : t(locale, 'kn.up.completing');
  const percentOf = (p: UploadProgress) =>
    p.phase === 'hashing'
      ? p.percent
      : p.phase === 'sending'
        ? Math.round((p.done / p.total) * 100)
        : 100;

  return (
    <section
      className="knu"
      aria-label={t(locale, resource ? 'kn.up.versionTitle' : 'kn.up.title')}
    >
      <Button
        variant={resource ? 'secondary' : 'primary'}
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        {t(locale, resource ? 'kn.up.versionTitle' : 'kn.up.button')}
      </Button>
      {open && (
        <form
          ref={form}
          className="nz-card knu-panel"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) void start();
          }}
        >
          <h2 className="nz-h2">{t(locale, resource ? 'kn.up.versionTitle' : 'kn.up.title')}</h2>
          <div
            className="knu-drop"
            data-over={over || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
          >
            <p>{file ? <bdi dir="auto">{file.name}</bdi> : t(locale, 'kn.up.drop')}</p>
            {file && <p className="nz-muted">{formatBytes(file.size, locale)}</p>}
            <label className="nz-btn" data-variant="secondary" aria-disabled={running || undefined}>
              {t(locale, 'kn.up.choose')}
              <input
                type="file"
                className="nz-sr-only"
                aria-label={t(locale, 'kn.up.file')}
                accept={ACCEPTED_SUFFIXES.join(',')}
                disabled={running}
                onChange={(e) => choose(e.target.files?.[0])}
              />
            </label>
            <p className="nz-muted">{t(locale, 'kn.up.types')}</p>
            {fileError && (
              <p role="alert" className="nz-error-text">
                {fileError}
              </p>
            )}
          </div>

          {!resource && (
            <div className="knu-grid">
              <Field id="knu-name" label={t(locale, 'kn.up.name')} error={nameError ?? undefined}>
                {(a) => <Input {...a} name="name" maxLength={200} disabled={running} />}
              </Field>
              <Field id="knu-type" label={t(locale, 'kn.up.type')}>
                {(a) => (
                  <Select {...a} name="resourceType" defaultValue="THEME" disabled={running}>
                    {RESOURCE_TYPES.map((x) => (
                      <option key={x} value={x}>
                        {t(locale, `kn.type.${x}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="knu-platform" label={t(locale, 'kn.up.platform')}>
                {(a) => (
                  <Select {...a} name="platform" defaultValue="" disabled={running}>
                    <option value="">{t(locale, 'kn.up.none')}</option>
                    {PLATFORMS.map((x) => (
                      <option key={x} value={x}>
                        {t(locale, `kn.platform.${x}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="knu-category" label={t(locale, 'kn.up.category')}>
                {(a) => <Input {...a} name="category" maxLength={80} disabled={running} />}
              </Field>
              <Field id="knu-frameworks" label={t(locale, 'kn.up.frameworks')}>
                {(a) => <Input {...a} name="frameworks" dir="ltr" disabled={running} />}
              </Field>
              <Field id="knu-languages" label={t(locale, 'kn.up.languages')}>
                {(a) => <Input {...a} name="languages" dir="ltr" disabled={running} />}
              </Field>
              <Field id="knu-tags" label={t(locale, 'kn.up.tags')}>
                {(a) => <Input {...a} name="tags" disabled={running} />}
              </Field>
              <Field id="knu-license" label={t(locale, 'kn.up.license')}>
                {(a) => (
                  <Input {...a} name="license" dir="ltr" maxLength={120} disabled={running} />
                )}
              </Field>
              <Field id="knu-description" label={t(locale, 'kn.up.description')}>
                {(a) => <Input {...a} name="description" maxLength={4000} disabled={running} />}
              </Field>
            </div>
          )}

          {running && (
            <div role="status" aria-live="polite" className="knu-progress">
              <Meter label={t(locale, 'kn.up.progress')} percent={percentOf(state.progress)} />
              <p>{progressText(state.progress)}</p>
              {state.progress.phase === 'sending' && state.progress.resumed > 0 && (
                <p className="nz-muted">
                  {t(locale, 'kn.up.resumed', {
                    done: String(state.progress.resumed),
                    total: String(state.progress.total),
                  })}
                </p>
              )}
            </div>
          )}
          {state.kind === 'done' && (
            <Banner tone="warn">
              {t(locale, 'kn.up.done')}{' '}
              {!resource && (
                <a
                  href={`/${locale}/ai-intelligence/library/${state.resourceId}`}
                  style={{ textDecoration: 'underline' }}
                >
                  {t(locale, 'kn.up.open')}
                </a>
              )}
            </Banner>
          )}
          {state.kind === 'cancelled' && <p role="status">{t(locale, 'kn.up.cancelled')}</p>}
          {state.kind === 'error' && (
            <p role="alert" className="nz-error-text">
              {t(locale, ERR[state.code])}
            </p>
          )}

          <div className="nz-row">
            {running ? (
              <Button variant="danger" onClick={() => void cancel()}>
                {t(locale, 'kn.up.cancel')}
              </Button>
            ) : (
              <Button type="submit" disabled={state.kind === 'done'}>
                {t(locale, 'kn.up.start')}
              </Button>
            )}
            <Button variant="secondary" disabled={running} onClick={() => setOpen(false)}>
              {t(locale, 'kn.up.close')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

const ERR: Record<UploadErrorCode, MessageKey> = {
  type: 'kn.up.err.type',
  size: 'kn.up.err.size',
  forbidden: 'kn.up.err.forbidden',
  network: 'kn.up.err.network',
  mismatch: 'kn.up.err.mismatch',
  aborted: 'kn.up.err.generic',
  generic: 'kn.up.err.generic',
};
