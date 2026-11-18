'use client';
import { useRouter } from 'next/navigation';
import { t, type Locale } from '@nuzm/i18n';
import { Button } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { Note, useStaffAction } from './BillingAdminPanels';

const key = () => crypto.randomUUID();

/** UI-M07-09: probe a registrar account (read-only); the result is stored with its evidence kind (mock/fixture = NOT VERIFIED). */
export function VerifyButton({
  locale,
  id,
  mfaFactorId,
}: {
  locale: Locale;
  id: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/admin/registrars/{id}/verification', {
                params: { path: { id }, header: { 'Idempotency-Key': key() } },
                body: {},
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(locale, 'dom.admin.reg.verified') });
              router.refresh();
            },
            { 422: t(locale, 'dom.detail.unsupported'), 503: t(locale, 'state.error.title') },
          )
        }
      >
        {t(locale, 'dom.admin.reg.verify')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}

/** UI-M07-10: force a reconciliation of one domain (looks at the registrar, finishes parked orders). */
export function ReconcileButton({
  locale,
  id,
  mfaFactorId,
}: {
  locale: Locale;
  id: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/admin/domains/{id}/reconciliations', {
                params: { path: { id }, header: { 'Idempotency-Key': key() } },
              }),
            (data) => {
              a.setNotice({
                tone: 'ok',
                text: t(locale, 'dom.admin.orders.reconciled', {
                  results: ((data as { results?: string[] } | undefined)?.results ?? []).join(', '),
                }),
              });
              router.refresh();
            },
          )
        }
      >
        {t(locale, 'dom.admin.orders.reconcile')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}

/** UI-M07-11: start an RC-04 run for today (finance). Variances appear in the finance reconciliation screen (the same run). */
export function RunRc04Button({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Button
        type="button"
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/admin/billing/reconciliations', {
                body: { types: ['RC-04'], periodFrom: today, periodTo: today } as never,
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(locale, 'dom.admin.recon.started') });
              router.refresh();
            },
          )
        }
      >
        {t(locale, 'dom.admin.recon.run')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}
