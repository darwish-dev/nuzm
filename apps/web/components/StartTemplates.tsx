'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Icon, type IconName } from '@nuzm/ui';
import type { TemplateId } from '../lib/builder';

/**
 * Templates for the start screen: a button beside the prompt's "+" opens a popup with one tab per project type (website, web app, mobile app). Each
 * template is a ready description of a real kind of project; picking one selects that type, puts the description in the prompt (to read and edit before
 * starting) and, for a website, also chooses the matching bilingual site template. A type the organization cannot start yet is shown as "coming soon".
 */
export type TemplateKind = 'website' | 'webapp' | 'mobile';
export interface StartTemplate {
  id: string;
  kind: TemplateKind;
  icon: IconName;
  title: MessageKey;
  prompt: MessageKey;
  /** the bilingual site template a website starts from */
  siteTemplate?: TemplateId;
}

export const START_TEMPLATES: StartTemplate[] = [
  {
    id: 'restaurant',
    kind: 'website',
    icon: 'hosting',
    title: 'bld.land.exTitle.restaurant',
    prompt: 'bld.start.ex.restaurant',
    siteTemplate: 'restaurant',
  },
  {
    id: 'portfolio',
    kind: 'website',
    icon: 'user',
    title: 'bld.land.exTitle.portfolio',
    prompt: 'bld.start.ex.portfolio',
    siteTemplate: 'portfolio',
  },
  {
    id: 'clinic',
    kind: 'website',
    icon: 'shield',
    title: 'bld.land.exTitle.clinic',
    prompt: 'bld.start.ex.clinic',
    siteTemplate: 'clinic',
  },
  {
    id: 'shop',
    kind: 'website',
    icon: 'tag',
    title: 'bld.land.exTitle.shop',
    prompt: 'bld.start.ex.shop',
    siteTemplate: 'retail',
  },
  {
    id: 'crm',
    kind: 'webapp',
    icon: 'organization',
    title: 'bld.land.exTitle.crm',
    prompt: 'm10a.start.ex.crm',
  },
  {
    id: 'inventory',
    kind: 'webapp',
    icon: 'data',
    title: 'bld.land.exTitle.inventory',
    prompt: 'm10a.start.ex.inventory',
  },
  {
    id: 'booking',
    kind: 'webapp',
    icon: 'calendar',
    title: 'bld.land.exTitle.booking',
    prompt: 'm10a.start.ex.booking',
  },
  {
    id: 'salon',
    kind: 'mobile',
    icon: 'calendar',
    title: 'bld.tpl.m.salon.title',
    prompt: 'bld.tpl.m.salon.prompt',
  },
  {
    id: 'delivery',
    kind: 'mobile',
    icon: 'basket',
    title: 'bld.tpl.m.delivery.title',
    prompt: 'bld.tpl.m.delivery.prompt',
  },
  {
    id: 'fitness',
    kind: 'mobile',
    icon: 'pulse',
    title: 'bld.tpl.m.fitness.title',
    prompt: 'bld.tpl.m.fitness.prompt',
  },
];

const KINDS: { id: TemplateKind; icon: IconName }[] = [
  { id: 'website', icon: 'globe' },
  { id: 'webapp', icon: 'code' },
  { id: 'mobile', icon: 'phone' },
];

export function TemplatesButton({
  locale,
  initialKind,
  available,
  onPick,
}: {
  locale: Locale;
  /** the tab that opens first: the type currently selected on the start screen */
  initialKind: TemplateKind;
  /** which types the organization can start */
  available: Record<TemplateKind, boolean>;
  onPick: (tpl: StartTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TemplateKind>(initialKind);
  const btn = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);

  const list = START_TEMPLATES.filter((x) => x.kind === kind);
  const typeName = (k: TemplateKind) => t(locale, `bld.start.type.${k}` as MessageKey);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="bl-tpl-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setKind(initialKind);
          setOpen(true);
        }}
      >
        <Icon name="grid" size={16} />
        <span>{t(locale, 'bld.tpl.button')}</span>
      </button>
      {/* rendered on the page itself: inside the prompt box (a blurred, filtered surface) a fixed popup would be clipped to the box */}
      {open &&
        createPortal(
          <div className="bl-tpl-scrim" onClick={close}>
            <div
              ref={dialog}
              className="bl-tpl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="bl-tpl-h"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="bl-tpl-head">
                <div>
                  <h2 id="bl-tpl-h">{t(locale, 'bld.tpl.title')}</h2>
                  <p>{t(locale, 'bld.tpl.sub')}</p>
                </div>
                <button
                  type="button"
                  className="bl-chip-x"
                  aria-label={t(locale, 'bld.tpl.close')}
                  onClick={close}
                >
                  <Icon name="close" size={16} />
                </button>
              </header>
              <div
                className="bl-tpl-tabs"
                role="tablist"
                aria-label={t(locale, 'bld.start.type.group')}
              >
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="tab"
                    id={`bl-tpl-tab-${k.id}`}
                    aria-selected={kind === k.id}
                    aria-controls="bl-tpl-panel"
                    tabIndex={kind === k.id ? 0 : -1}
                    onClick={() => setKind(k.id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                      const i = KINDS.findIndex((x) => x.id === kind);
                      const rtl = document.documentElement.dir === 'rtl';
                      const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
                      const next = KINDS[(i + step + KINDS.length) % KINDS.length]!.id;
                      setKind(next);
                      dialog.current?.querySelector<HTMLElement>(`#bl-tpl-tab-${next}`)?.focus();
                    }}
                  >
                    <Icon name={k.icon} size={15} />
                    {typeName(k.id)}
                    {!available[k.id] && <small>{t(locale, 'bld.start.soon')}</small>}
                  </button>
                ))}
              </div>
              <div
                className="bl-tpl-grid"
                role="tabpanel"
                id="bl-tpl-panel"
                aria-labelledby={`bl-tpl-tab-${kind}`}
              >
                {!available[kind] && (
                  <p className="bl-note bl-tpl-soon" role="status">
                    {t(locale, 'bld.start.soonNote', { type: typeName(kind) })}
                  </p>
                )}
                {list.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="bl-tpl-card"
                    data-kind={tpl.kind}
                    data-tpl={tpl.id}
                    disabled={!available[kind]}
                    onClick={() => {
                      onPick(tpl);
                      setOpen(false);
                    }}
                  >
                    <span className="bl-tpl-art" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <span className="bl-tpl-icon">
                        <Icon name={tpl.icon} size={20} />
                      </span>
                    </span>
                    <span className="bl-tpl-body">
                      <b>{t(locale, tpl.title)}</b>
                      <small>{t(locale, tpl.prompt)}</small>
                    </span>
                    <span className="bl-tpl-use">
                      {t(locale, 'bld.land.use')}
                      <Icon name="arrow" size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
