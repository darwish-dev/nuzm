'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Icon, type IconName } from '@nuzm/ui';
import { AppBuildingScene } from './AppBuildingScene';
import { BrandMark } from './BrandLogo';
import { MobileBuildingScene } from './MobileBuildingScene';

export interface ShellTab<T extends string = string> {
  id: T;
  icon: IconName;
  label: string;
}

/** The selected panel of a workspace, kept in the address (`?tab=`) without a navigation, so a reload or a shared link opens the same panel. */
export function useShellTab<T extends string>(initial: T): [T, (next: T) => void] {
  const [tab, setTab] = useState<T>(initial);
  const select = (next: T) => {
    setTab(next);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('tab', next);
      u.searchParams.delete('new');
      window.history.replaceState(window.history.state, '', u);
    } catch {
      /* the address stays as it is: the tab still changes */
    }
  };
  return [tab, select];
}

/**
 * The shell every project type of the builder shares: the full-screen frame, the slim top bar (logo, all projects, name, the panel tabs, the controls of the
 * panel, the primary action, a menu, close), the chat column on the left and the canvas on the right (with a banner slot and the "working" toast). It holds no
 * project logic: the website workspace, the web-app mode and the mobile mode put their own chat, controls and panels into it.
 */
export function WorkspaceShell<T extends string>({
  locale,
  mode,
  backHref,
  name,
  tabsLabel,
  tabs,
  tab,
  onTab,
  controls,
  primary,
  menu,
  chat,
  banner,
  working,
  scene = false,
  children,
}: {
  locale: Locale;
  mode: 'mobile' | 'webapp';
  backHref: string;
  name: string;
  tabsLabel: string;
  tabs: ShellTab<T>[];
  tab: T;
  onTab: (next: T) => void;
  /** segmented controls of the open panel (device, language, theme ...) */
  controls?: ReactNode;
  /** the primary action (Build, Deploy): a button or a link styled as the top bar's accent */
  primary?: ReactNode;
  /** entries of the "more" menu, as `<li>` elements; the menu is omitted when there are none */
  menu?: ReactNode;
  chat: ReactNode;
  /** an error banner above the canvas (the project could not be reloaded) */
  banner?: string | null;
  /** the step being worked on while a run works: shown as a toast over the canvas */
  working?: { active: boolean; label: string };
  /** show the "being built" scene over the canvas (a run is working and the preview is open); it stays a moment after the run ends so it fades out */
  scene?: boolean;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<'off' | 'on' | 'leaving'>('off');
  useEffect(() => {
    if (scene) return setPhase('on');
    setPhase((p) => (p === 'on' ? 'leaving' : p));
    const h = setTimeout(() => setPhase((p) => (p === 'leaving' ? 'off' : p)), 700);
    return () => clearTimeout(h);
  }, [scene]);
  return (
    <div className="bws mws" data-inspector="closed" data-mode={mode}>
      <header className="bws-top">
        <a className="bws-logo" href={`/${locale}`} aria-label={t(locale, 'bld.ws.home')}>
          <BrandMark />
        </a>
        <a
          className="bws-back"
          href={backHref}
          aria-label={t(locale, 'bld.ws.back')}
          title={t(locale, 'bld.ws.back')}
        >
          <Icon name="arrow" size={18} />
        </a>
        <h2 className="bws-title">
          <bdi dir="auto">{name}</bdi>
        </h2>
        <div className="bws-seg mws-tabs-seg" role="group" aria-label={tabsLabel}>
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={tab === x.id}
              onClick={() => onTab(x.id)}
              data-tab={x.id}
            >
              <Icon name={x.icon} size={16} />
              {x.label}
            </button>
          ))}
        </div>
        <span className="bws-spacer" />
        {controls}
        {menu && (
          <details className="bws-more">
            <summary aria-label={t(locale, 'bld.ws.more')} title={t(locale, 'bld.ws.more')}>
              <Icon name="more" size={18} />
            </summary>
            <ul>{menu}</ul>
          </details>
        )}
        {primary}
        <a
          className="bws-exit"
          href={`/${locale}`}
          aria-label={t(locale, 'bld.ws.exit')}
          title={t(locale, 'bld.ws.exit')}
        >
          <Icon name="close" size={18} />
        </a>
      </header>

      <div className="bws-body">
        <section className="bws-chat" aria-label={t(locale, 'bld.ws.chat')}>
          {chat}
        </section>
        <section className="bws-canvas" aria-label={t(locale, 'bld.ws.canvas')}>
          {banner && <Banner tone="danger">{banner}</Banner>}
          {phase !== 'off' && (
            <div className="bscene-wrap" data-leaving={phase === 'leaving' ? 'true' : undefined}>
              {mode === 'mobile' ? (
                <MobileBuildingScene locale={locale} label={working?.label ?? ''} />
              ) : (
                <AppBuildingScene locale={locale} label={working?.label ?? ''} />
              )}
            </div>
          )}
          {working?.active && (
            <div className="bws-working" role="status">
              <span className="bld-spinner" aria-hidden="true" />
              {working.label || t(locale, 'bld.card.working')}
            </div>
          )}
          {children}
        </section>
      </div>
    </div>
  );
}
