'use client';
import { useEffect, useState } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, ButtonLink, Ltr } from '@nuzm/ui';
import { browserCompute } from '../lib/compute-client';
import { panelPollMs, panelUrl, type PanelInstall, type PanelStage } from '../lib/compute';

const STAGE_TONE: Record<PanelStage, 'success' | 'warn' | 'danger' | undefined> = {
  create_server: undefined,
  waiting_boot: undefined,
  installing_panel: undefined,
  registering: undefined,
  readiness: undefined,
  ready: 'success',
  needs_attention: 'danger',
  held: 'warn',
};

/**
 * The HestiaCP install of a VPS, stage by stage (S04): create server → wait for boot → install panel → register link → readiness test → ready / needs attention, a held
 * order (no provider capacity in the sold region), and the panel LINK, which is separate from the server: when it is lost the provider actions (start, stop, restart) stay.
 * The page follows the install by itself and never shows a secret; the only value copied to the screen is the command to re-run on the server.
 */
export function VpsPanelCard({
  locale,
  instanceId,
  initial,
  canAct,
}: {
  locale: Locale;
  instanceId: string;
  initial: PanelInstall;
  canAct: boolean;
}) {
  const [p, setP] = useState<PanelInstall>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const [rerun, setRerun] = useState<string | null>(null);

  useEffect(() => {
    const ms = panelPollMs(p.stage);
    if (!ms) return;
    const id = setInterval(() => {
      void browserCompute
        .get<PanelInstall>(`/v1/compute/instances/${instanceId}/panel`)
        .then((r) => r.response.ok && r.data && setP(r.data))
        .catch(() => undefined);
    }, ms);
    return () => clearInterval(id);
  }, [p.stage, instanceId]);

  async function retry() {
    setBusy(true);
    setProblem(false);
    try {
      const r = await browserCompute.post<{
        action: string;
        command?: string;
        panel: PanelInstall;
      }>(`/v1/compute/instances/${instanceId}/panel/retry`, {
        idempotencyKey: crypto.randomUUID(),
      });
      if (r.response.ok && r.data) {
        setP(r.data.panel);
        setRerun(r.data.action === 'rerun_bootstrap' ? (r.data.command ?? null) : null);
      } else setProblem(true);
    } catch {
      setProblem(true);
    } finally {
      setBusy(false);
    }
  }

  const attn = p.attention;
  return (
    <section className="nzc-panel" aria-labelledby="vps-panel-h">
      <h2 id="vps-panel-h">{t(locale, 'vps.panel.title')}</h2>
      <p className="nz-row">
        <Badge tone={STAGE_TONE[p.stage]}>{t(locale, `vps.panel.stage.${p.stage}`)}</Badge>
        <span className="nz-muted">
          HestiaCP <Ltr>{p.panelVersion}</Ltr> · {p.osName} ·{' '}
          {t(locale, p.template.mail ? 'vps.panel.tpl.mail' : 'vps.panel.tpl.web')}
        </span>
      </p>

      <ol className="nzc-steps-row" aria-label={t(locale, 'vps.panel.steps')}>
        {p.steps.map((s) => (
          <li
            key={s.key}
            data-state={s.state}
            aria-current={s.state === 'running' ? 'step' : undefined}
          >
            <Badge
              tone={s.state === 'done' ? 'success' : s.state === 'failed' ? 'danger' : undefined}
            >
              {t(locale, `vps.panel.state.${s.state}`)}
            </Badge>{' '}
            {t(locale, `vps.panel.step.${s.key}`)}
          </li>
        ))}
      </ol>

      {p.stage === 'held' && (
        <Banner tone="warn">
          <strong>{t(locale, 'vps.panel.held.title')}</strong> {t(locale, 'vps.panel.held.body')}
        </Banner>
      )}

      {attn && (
        <Banner tone="danger">
          <strong>{t(locale, 'vps.panel.attn.title')}</strong>{' '}
          {tDynamic(locale, `vps.panel.attn.${attn.code}`, t(locale, 'vps.panel.attn.other'))}
          {attn.resumable === 'support' && <> {t(locale, 'vps.panel.attn.support')}</>}
        </Banner>
      )}
      {attn && attn.resumable !== 'support' && canAct && (
        <p>
          <Button variant="secondary" disabled={busy} onClick={() => void retry()}>
            {t(locale, 'vps.panel.retry')}
          </Button>
        </p>
      )}
      {rerun && (
        <p>
          {t(locale, 'vps.panel.rerun')}{' '}
          <Ltr>
            <code>{rerun}</code>
          </Ltr>
        </p>
      )}
      {problem && (
        <p className="nz-error-text" role="alert">
          {t(locale, 'vps.panel.retry.err')}
        </p>
      )}

      {p.stage === 'ready' && (
        <>
          <p className="nz-row">
            <Badge tone={p.panelLink === 'connected' ? 'success' : 'warn'}>
              {t(locale, `vps.panel.link.${p.panelLink}`)}
            </Badge>
            <Ltr>
              {p.panelHost}:{p.panelPort}
            </Ltr>
          </p>
          {p.panelLink === 'lost' && (
            <Banner tone="warn">{t(locale, 'vps.panel.link.lost.note')}</Banner>
          )}
          <p>
            <ButtonLink variant="secondary" href={panelUrl(p)}>
              {t(locale, 'vps.panel.open')}
            </ButtonLink>
          </p>
          <p className="nz-muted">
            {t(locale, 'vps.panel.password')}{' '}
            <Ltr>
              <code>{p.adminPasswordFile}</code>
            </Ltr>
          </p>
        </>
      )}
    </section>
  );
}
