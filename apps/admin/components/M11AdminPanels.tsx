'use client';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  DECISIONS,
  SCAN_OVERRIDE,
  moderationBody,
  moderationErrors,
  type Decision,
} from '../lib/m11';
import { Note, useStaffAction } from './BillingAdminPanels';

interface Result {
  listingId: string;
  versionId: string;
  decision: Decision;
  versionStatus: string;
  listingStatus: string;
}

/**
 * UI-M11-20: the moderation DECISION on a listing version. The queue itself (which versions wait, their scan results) cannot be listed yet (SCR-M11-05, not approved), so the person pastes
 * the listing id and, optionally, the version id. The API needs a recent MFA verification (step-up) and answers 409 when the version is no longer in the state the decision needs.
 */
export function ModerationForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const a = useStaffAction(locale, mfaFactorId);
  const [listingId, setListingId] = useState('');
  const [decision, setDecision] = useState<Decision>('approve');
  const [reasonCode, setReasonCode] = useState('');
  const [notes, setNotes] = useState('');
  const [versionId, setVersionId] = useState('');
  const [err, setErr] = useState<ReturnType<typeof moderationErrors>>({});
  const [result, setResult] = useState<Result | null>(null);

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = moderationErrors({ listingId, decision, reasonCode, notes, versionId });
    setErr(e);
    setResult(null);
    if (Object.keys(e).length > 0) return;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/marketplace/listings/{id}/moderation', {
          params: { path: { id: listingId.trim().toLowerCase() } },
          body: moderationBody({ decision, reasonCode, notes, versionId }),
        }),
      (r) => setResult(r as unknown as Result),
      {
        403: t(locale, 'm11.adm.mod.forbidden'),
        404: t(locale, 'm11.adm.mod.notFound'),
        409: t(locale, 'm11.adm.mod.stale'),
        422: t(locale, 'm11.adm.mod.refused'),
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm11.adm.mod.form')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(locale, 'm11.adm.mod.form')}</h2>
      <Field
        id="mod-listing"
        label={t(locale, 'm11.adm.mod.listingId')}
        help={t(locale, 'm11.adm.mod.listingIdHelp')}
        error={err.listingId ? t(locale, 'm11.adm.mod.err.listing') : undefined}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            value={listingId}
            onChange={(e) => setListingId(e.target.value)}
          />
        )}
      </Field>
      <Field id="mod-decision" label={t(locale, 'm11.adm.mod.decision')}>
        {(x) => (
          <Select {...x} value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {t(locale, `m11.adm.mod.decision.${d}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="mod-reason"
        label={t(locale, 'm11.adm.mod.reason')}
        help={t(locale, 'm11.adm.mod.reasonHelp', { code: SCAN_OVERRIDE })}
        error={err.reasonCode ? t(locale, 'm11.adm.mod.err.reason') : undefined}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
          />
        )}
      </Field>
      <Field
        id="mod-version"
        label={t(locale, 'm11.adm.mod.versionId')}
        help={t(locale, 'm11.adm.mod.versionIdHelp')}
        error={err.versionId ? t(locale, 'm11.adm.mod.err.version') : undefined}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
          />
        )}
      </Field>
      <Field
        id="mod-notes"
        label={t(locale, 'm11.adm.mod.notes')}
        error={err.notes ? t(locale, 'm11.adm.mod.err.notes') : undefined}
      >
        {(x) => (
          <textarea
            {...x}
            className="nz-input"
            rows={4}
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant={decision === 'approve' ? 'primary' : 'danger'}
        disabled={a.busy}
      >
        {t(locale, `m11.adm.mod.submit.${decision}`)}
      </Button>
      <Note n={a.notice} />
      {a.panel}
      {result && (
        <div role="status">
          <Banner tone="warn">
            {t(locale, 'm11.adm.mod.done', {
              decision: tDynamic(
                locale,
                `m11.adm.mod.decision.${result.decision}`,
                result.decision,
              ),
            })}
          </Banner>
          <dl>
            <dt>{t(locale, 'm11.adm.mod.listingId')}</dt>
            <dd>
              <Ltr>{result.listingId}</Ltr>
            </dd>
            <dt>{t(locale, 'm11.adm.mod.versionId')}</dt>
            <dd>
              <Ltr>{result.versionId}</Ltr>
            </dd>
            <dt>{t(locale, 'm11.adm.mod.versionStatus')}</dt>
            <dd>
              <Badge>
                {tDynamic(locale, `m11.pub.mod.${result.versionStatus}`, result.versionStatus)}
              </Badge>
            </dd>
            <dt>{t(locale, 'm11.adm.mod.listingStatus')}</dt>
            <dd>
              <Badge>
                {tDynamic(locale, `m11.pub.status.${result.listingStatus}`, result.listingStatus)}
              </Badge>
            </dd>
          </dl>
        </div>
      )}
    </form>
  );
}
