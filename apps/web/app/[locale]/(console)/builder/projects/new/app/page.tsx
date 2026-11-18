import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { AppWizard } from '../../../../../../../components/AppWizard';
import { DEFAULT_BUDGET } from '../../../../../../../lib/builder';
import { bgate } from '../../../../../../../lib/builder-gate';

/** UI-M10-01: app-generation wizard (prompt, requirements review, budget, start). The budget defaults come from `GET /v1/ai/budgets` when the member may read it. */
export default async function NewApp({ params }: { params: Promise<{ locale: string }> }) {
  const g = await bgate(params, 'builder:write', 'm10.wiz.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  let defaults: { maxTokens: number; maxCostMinor: number; maxMinutes: number } = {
    ...DEFAULT_BUDGET,
  };
  let credit: number | null = null;
  if (s.can('ai:budget')) {
    try {
      const b = await unwrap(s.api.GET('/v1/ai/budgets', {}));
      const d = (b.defaults ?? {}) as Record<string, unknown>;
      const num = (v: unknown, f: number) =>
        typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : f;
      defaults = {
        maxTokens: num(d.maxTokens, defaults.maxTokens),
        maxCostMinor: num(d.maxCostMinor, defaults.maxCostMinor),
        maxMinutes: num(d.maxMinutes, defaults.maxMinutes),
      };
      credit = b.orgRemainingMinor;
    } catch {
      // the defaults of the wizard apply; the API checks the budget again when the run starts
    }
  }
  return (
    <>
      <PageTitle>{t(locale, 'm10.wiz.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm10.wiz.help')}</p>
      <AppWizard
        locale={locale}
        mfaFactorId={s.me.mfaFactorId ?? null}
        defaults={defaults}
        orgRemainingMinor={credit}
      />
    </>
  );
}
