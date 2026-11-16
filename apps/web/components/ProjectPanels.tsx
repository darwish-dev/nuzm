'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Button, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

const confirmDelete = (locale: Locale, name: string) =>
  window.confirm(t(locale, 'confirm.delete', { name }));

export function WorkspacesPanel(p: {
  locale: Locale;
  items: { id: string; name: string; slug: string }[];
  canWrite: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const a = useAction(p.locale, null);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name')).trim();
    void a.run(
      () =>
        browserApi().POST('/v1/workspaces', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { name },
        }),
      () => {
        form.reset();
        router.refresh();
      },
    );
  }
  return (
    <>
      {p.canWrite && (
        <form onSubmit={submit} noValidate className="nz-row">
          <Field id="ws-name" label={t(p.locale, 'field.name')}>
            {(x) => <Input name="name" required maxLength={120} {...x} />}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'action.create')}
          </Button>
        </form>
      )}
      <NoticeText notice={a.notice} />
      <Table
        caption={t(p.locale, 'workspaces.title')}
        rows={p.items}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: t(p.locale, 'field.name'), render: (r) => r.name },
          { key: 's', header: t(p.locale, 'field.slug'), render: (r) => <Ltr>{r.slug}</Ltr> },
          {
            key: 'a',
            header: t(p.locale, 'field.action'),
            render: (r) =>
              p.canDelete ? (
                <Button
                  variant="danger"
                  disabled={a.busy}
                  onClick={() =>
                    confirmDelete(p.locale, r.name) &&
                    void a.run(
                      () =>
                        browserApi().DELETE('/v1/workspaces/{id}', {
                          params: { path: { id: r.id } },
                        }),
                      () => router.refresh(),
                      { 409: t(p.locale, 'err.conflict') },
                    )
                  }
                >
                  {t(p.locale, 'action.delete')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </>
  );
}

export function ProjectsPanel(p: {
  locale: Locale;
  items: { id: string; name: string; workspaceId: string }[];
  workspaces: { id: string; name: string }[];
  canWrite: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const a = useAction(p.locale, null);
  const wsName = new Map(p.workspaces.map((w) => [w.id, w.name]));
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void a.run(
      () =>
        browserApi().POST('/v1/projects', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { workspaceId: String(f.get('workspaceId')), name: String(f.get('name')).trim() },
        }),
      () => {
        form.reset();
        router.refresh();
      },
    );
  }
  return (
    <>
      {p.canWrite && p.workspaces.length > 0 && (
        <form onSubmit={submit} noValidate className="nz-row">
          <Field id="pr-ws" label={t(p.locale, 'field.workspace')}>
            {(x) => (
              <Select name="workspaceId" {...x}>
                {p.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="pr-name" label={t(p.locale, 'field.name')}>
            {(x) => <Input name="name" required maxLength={120} {...x} />}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'action.create')}
          </Button>
        </form>
      )}
      <NoticeText notice={a.notice} />
      <Table
        caption={t(p.locale, 'projects.title')}
        rows={p.items}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'n',
            header: t(p.locale, 'field.name'),
            render: (r) => <a href={`/${p.locale}/projects/${r.id}/environments`}>{r.name}</a>,
          },
          {
            key: 'w',
            header: t(p.locale, 'field.workspace'),
            render: (r) => wsName.get(r.workspaceId) ?? '—',
          },
          {
            key: 'a',
            header: t(p.locale, 'field.action'),
            render: (r) =>
              p.canDelete ? (
                <Button
                  variant="danger"
                  disabled={a.busy}
                  onClick={() =>
                    confirmDelete(p.locale, r.name) &&
                    void a.run(
                      () =>
                        browserApi().DELETE('/v1/projects/{id}', {
                          params: { path: { id: r.id } },
                        }),
                      () => router.refresh(),
                    )
                  }
                >
                  {t(p.locale, 'action.delete')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </>
  );
}

const KINDS = ['dev', 'staging', 'prod'] as const;

export function EnvironmentsPanel(p: {
  locale: Locale;
  projectId: string;
  items: { id: string; name: string; kind: string; dataRegion: string }[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const a = useAction(p.locale, null);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void a.run(
      () =>
        browserApi().POST('/v1/projects/{id}/environments', {
          params: { path: { id: p.projectId }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            name: String(f.get('name')).trim(),
            kind: String(f.get('kind')) as (typeof KINDS)[number],
          },
        }),
      () => {
        form.reset();
        router.refresh();
      },
    );
  }
  return (
    <>
      {p.canWrite && (
        <form onSubmit={submit} noValidate className="nz-row">
          <Field id="env-name" label={t(p.locale, 'field.name')}>
            {(x) => <Input name="name" required maxLength={60} {...x} />}
          </Field>
          <Field id="env-kind" label={t(p.locale, 'field.kind')}>
            {(x) => (
              <Select name="kind" defaultValue="dev" {...x}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'action.create')}
          </Button>
        </form>
      )}
      <NoticeText notice={a.notice} />
      <Table
        caption={t(p.locale, 'environments.title')}
        rows={p.items}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: t(p.locale, 'field.name'), render: (r) => r.name },
          { key: 'k', header: t(p.locale, 'field.kind'), render: (r) => <Badge>{r.kind}</Badge> },
          {
            key: 'r',
            header: t(p.locale, 'field.region'),
            render: (r) => <Ltr>{r.dataRegion}</Ltr>,
          },
          {
            key: 'a',
            header: t(p.locale, 'field.action'),
            render: (r) =>
              p.canWrite ? (
                <Button
                  variant="danger"
                  disabled={a.busy}
                  onClick={() =>
                    confirmDelete(p.locale, r.name) &&
                    void a.run(
                      () =>
                        browserApi().DELETE('/v1/projects/{id}/environments/{envId}', {
                          params: { path: { id: p.projectId, envId: r.id } },
                        }),
                      () => router.refresh(),
                    )
                  }
                >
                  {t(p.locale, 'action.delete')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </>
  );
}

export function OperationsTable(p: {
  locale: Locale;
  items: {
    id: string;
    kind: string;
    state: string;
    attempts: number;
    traceId?: string | null;
    cancelRequested: boolean;
  }[];
  canCancel: boolean;
  fmt: Record<string, string>;
}) {
  const router = useRouter();
  const a = useAction(p.locale, null);
  const terminal = new Set(['succeeded', 'failed', 'cancelled']);
  return (
    <>
      <Table
        caption={t(p.locale, 'operations.title')}
        rows={p.items}
        rowKey={(r) => r.id}
        columns={[
          { key: 'k', header: t(p.locale, 'field.kind'), render: (r) => <Ltr>{r.kind}</Ltr> },
          { key: 's', header: t(p.locale, 'field.state'), render: (r) => <Badge>{r.state}</Badge> },
          {
            key: 'at',
            header: t(p.locale, 'field.attempts'),
            render: (r) => <Ltr>{r.attempts}</Ltr>,
          },
          {
            key: 't',
            header: t(p.locale, 'field.traceId'),
            render: (r) => <Ltr>{r.traceId ?? '—'}</Ltr>,
          },
          { key: 'c', header: t(p.locale, 'field.created'), render: (r) => p.fmt[r.id] ?? '' },
          {
            key: 'a',
            header: t(p.locale, 'field.action'),
            render: (r) =>
              p.canCancel && !terminal.has(r.state) && !r.cancelRequested ? (
                <Button
                  variant="secondary"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(
                      () =>
                        browserApi().POST('/v1/operations/{id}/cancellation', {
                          params: { path: { id: r.id } },
                        }),
                      () => router.refresh(),
                      { 409: t(p.locale, 'err.conflict') },
                    )
                  }
                >
                  {t(p.locale, 'action.cancelOp')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <NoticeText notice={a.notice} />
    </>
  );
}
