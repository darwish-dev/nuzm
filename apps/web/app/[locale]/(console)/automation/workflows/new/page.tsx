import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { WorkflowEditor } from '../../../../../../components/WorkflowEditor';
import { FLAGS } from '../../../../../../lib/m11';
import { actingOrgOf, gateM11 } from '../../../../../../lib/m11-server';

/** UI-M11-02 (create mode): a new workflow = name + triggers + the first definition; the webhook trigger secret is shown once after creation. */
export default async function NewWorkflow({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'automation:write',
    title: 'm11.wf.new',
    flag: FLAGS.automation,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const acting = await actingOrgOf(s);
  return (
    <>
      <PageTitle>{t(locale, 'm11.wf.new')}</PageTitle>
      <WorkflowEditor
        locale={locale}
        mode="create"
        actingOrgId={acting}
        canWrite
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    </>
  );
}
