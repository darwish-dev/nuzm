'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

export const ORG_ROLES = ['owner', 'admin', 'billing_admin', 'developer', 'viewer'] as const;
type OrgRole = (typeof ORG_ROLES)[number];
const ifMatch = (v: number) => `"${v}"`;

interface Member {
  id: string;
  userId: string;
  email: string;
  displayName?: string | null;
  role: string;
  joinedAt: string;
  version: number;
}

export function MemberActions(p: {
  locale: Locale;
  orgId: string;
  member: Member;
  isSelf: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const refresh = () => router.refresh();
  const path = { orgId: p.orgId, userId: p.member.userId };
  return (
    <div>
      <div className="nz-row">
        <Select
          aria-label={t(p.locale, 'action.changeRole')}
          defaultValue={p.member.role}
          disabled={a.busy}
          onChange={(e) => {
            const role = e.target.value as OrgRole;
            void a.run(
              () =>
                browserApi().PATCH('/v1/organizations/{orgId}/members/{userId}', {
                  params: { path, header: { 'If-Match': ifMatch(p.member.version) } },
                  body: { role },
                }),
              () => router.refresh(),
              { 409: t(p.locale, 'members.lastOwner') },
            );
          }}
        >
          {ORG_ROLES.map((r) => (
            <option key={r} value={r}>
              {tDynamic(p.locale, `role.${r}`, r)}
            </option>
          ))}
        </Select>
        <Button
          variant="danger"
          disabled={a.busy}
          onClick={() => {
            if (!window.confirm(t(p.locale, 'confirm.delete', { name: p.member.email }))) return;
            void a.run(
              () =>
                browserApi().DELETE('/v1/organizations/{orgId}/members/{userId}', {
                  params: { path },
                }),
              refresh,
              { 409: t(p.locale, 'members.lastOwner') },
            );
          }}
        >
          {t(p.locale, 'action.remove')}
        </Button>
      </div>
      <NoticeText notice={a.notice} />
      {a.panel}
    </div>
  );
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}

export function InviteForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void a.run(
      () =>
        browserApi().POST('/v1/invitations', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { email: String(f.get('email')).trim(), role: String(f.get('role')) as OrgRole },
        }),
      () => {
        form.reset();
        a.setNotice({ tone: 'ok', text: t(locale, 'invite.sent') });
        router.refresh();
      },
    );
  }
  return (
    <form onSubmit={submit} noValidate className="nz-row">
      <Field id="inv-email" label={t(locale, 'field.email')}>
        {(x) => <Input name="email" type="email" required dir="ltr" autoComplete="off" {...x} />}
      </Field>
      <Field id="inv-role" label={t(locale, 'field.role')}>
        {(x) => (
          <Select name="role" defaultValue="viewer" {...x}>
            {ORG_ROLES.filter((r) => r !== 'owner').map((r) => (
              <option key={r} value={r}>
                {tDynamic(locale, `role.${r}`, r)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(locale, 'action.invite')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

export function InvitationsTable({
  locale,
  items,
  mfaFactorId,
  fmt,
}: {
  locale: Locale;
  items: Invitation[];
  mfaFactorId: string | null;
  fmt: Record<string, string>;
}) {
  const router = useRouter();
  const a = useAction(locale, mfaFactorId);
  return (
    <>
      <Table
        caption={t(locale, 'invitations.title')}
        rows={items}
        rowKey={(r) => r.id}
        columns={[
          { key: 'e', header: t(locale, 'field.email'), render: (r) => <Ltr>{r.email}</Ltr> },
          {
            key: 'r',
            header: t(locale, 'field.role'),
            render: (r) => tDynamic(locale, `role.${r.role}`, r.role),
          },
          {
            key: 's',
            header: t(locale, 'field.status'),
            render: (r) => (
              <Badge
                tone={
                  r.status === 'pending' ? 'warn' : r.status === 'accepted' ? 'success' : 'danger'
                }
              >
                {tDynamic(locale, `status.${r.status}`, r.status)}
              </Badge>
            ),
          },
          { key: 'x', header: t(locale, 'field.expires'), render: (r) => fmt[r.id] ?? r.expiresAt },
          {
            key: 'a',
            header: t(locale, 'field.action'),
            render: (r) =>
              r.status === 'pending' ? (
                <Button
                  variant="secondary"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(
                      () =>
                        browserApi().DELETE('/v1/invitations/{id}', {
                          params: { path: { id: r.id } },
                        }),
                      () => router.refresh(),
                    )
                  }
                >
                  {t(locale, 'action.revoke')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <NoticeText notice={a.notice} />
      {a.panel}
    </>
  );
}

export function AcceptInvitation({
  locale,
  id,
  token,
}: {
  locale: Locale;
  id: string;
  token: string;
}) {
  const a = useAction(locale, null);
  const [done, setDone] = useState(false);
  if (done)
    return (
      <p role="status">
        {t(locale, 'invite.accept.done')} <a href={`/${locale}`}>{t(locale, 'nav.home')}</a>
      </p>
    );
  return (
    <>
      <Button
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/invitations/{id}/acceptance', {
                params: { path: { id } },
                body: { token },
              }),
            () => setDone(true),
            {
              410: t(locale, 'invite.accept.gone'),
              403: t(locale, 'invite.accept.mismatch'),
              404: t(locale, 'invite.accept.gone'),
            },
          )
        }
      >
        {t(locale, 'action.accept')}
      </Button>
      <NoticeText notice={a.notice} />
    </>
  );
}
