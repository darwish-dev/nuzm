'use client';
import { useRouter } from 'next/navigation';
import { t, type Locale } from '@nuzm/i18n';
import { Button, EmptyState } from '@nuzm/ui';
import { browserCompute } from '../lib/compute-client';
import { useComputeAction } from '../lib/compute-actions';
import { actionAllowed } from '../lib/compute';
import { ProblemAlert } from './ComputeBits';
import { NoticeText } from './Feedback';

/**
 * UI-M05-06: snapshots. Offered only when the instance supports them (otherwise an empty state; the sub-navigation hides the link).
 * The S17 API has an action to CREATE a snapshot but no endpoint that lists them, so no list is shown: the page says so and points to Operations.
 */
export function SnapshotsPanel(p: {
  locale: Locale;
  instanceId: string;
  status: string;
  supported: boolean;
  canAct: boolean;
  mfaFactorId: string | null;
}) {
  const { locale } = p;
  const router = useRouter();
  const a = useComputeAction(locale, p.mfaFactorId);
  if (!p.supported)
    return (
      <EmptyState
        title={t(locale, 'm05.web.snap.unsupported.title')}
        body={t(locale, 'm05.web.snap.unsupported.body')}
      />
    );
  return (
    <section className="nz-card" aria-labelledby="snap-h">
      <h2 className="nz-h2" id="snap-h">
        {t(locale, 'm05.web.snap.title')}
      </h2>
      <p className="nz-muted">{t(locale, 'm05.web.snap.noList')}</p>
      {p.canAct ? (
        <Button
          disabled={a.busy || !actionAllowed('snapshot', p.status)}
          onClick={() =>
            void a.run(
              () =>
                browserCompute.post(`/v1/compute/instances/${p.instanceId}/actions`, {
                  body: { type: 'snapshot' },
                  idempotencyKey: crypto.randomUUID(),
                }),
              () => {
                a.setNotice({ tone: 'ok', text: t(locale, 'm05.web.snap.requested') });
                router.refresh();
              },
            )
          }
        >
          {t(locale, 'm05.web.snap.create')}
        </Button>
      ) : (
        <p className="nz-muted">{t(locale, 'm05.web.snap.readOnly')}</p>
      )}
      <p>
        <a href={`/operations`}>{t(locale, 'm05.web.snap.operations')}</a>
      </p>
      {a.problem ? (
        <ProblemAlert locale={locale} problem={a.problem} />
      ) : (
        <NoticeText notice={a.notice} />
      )}
      {a.panel}
    </section>
  );
}
