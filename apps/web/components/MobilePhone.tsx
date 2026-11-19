'use client';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import {
  biText,
  onColor,
  type PreviewField,
  type PreviewScreen,
  type PreviewSpec,
} from '../lib/mobile';

export type PhoneDevice = 'phone' | 'tablet';
type Lang = 'ar' | 'en';

/**
 * The text of the generated app's own chrome (what the Flutter template shows), in both languages. It mirrors `apps/api/templates/flutter-core`, so the preview
 * says what the real screens say; it is not part of the console's own messages.
 */
const APP_TEXT = {
  submit: { ar: 'إرسال', en: 'Submit' },
  empty: { ar: 'لا توجد عناصر بعد', en: 'Nothing here yet' },
  language: { ar: 'اللغة', en: 'Language' },
  appearance: { ar: 'المظهر', en: 'Appearance' },
  system: { ar: 'النظام', en: 'System' },
  light: { ar: 'فاتح', en: 'Light' },
  dark: { ar: 'داكن', en: 'Dark' },
  signOut: { ar: 'تسجيل الخروج', en: 'Sign out' },
  choose: { ar: 'اختر', en: 'Choose' },
} as const;
const at = (k: keyof typeof APP_TEXT, lang: Lang) => APP_TEXT[k][lang];

const KIND_ICON: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  form: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14 7l3 3',
  detail: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};
const KindIcon = ({ kind }: { kind: string }) => (
  <svg
    className="mws-ico"
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={KIND_ICON[kind] ?? KIND_ICON.detail} />
  </svg>
);

function FieldView({ f, lang }: { f: PreviewField; lang: Lang }) {
  const label = biText(f.label, lang) + (f.required ? ' *' : '');
  if (f.type === 'switch')
    return (
      <div className="mws-switch">
        <span>{biText(f.label, lang)}</span>
        <span className="mws-toggle" aria-hidden="true" />
      </div>
    );
  return (
    <div className="mws-field" data-type={f.type}>
      <span className="mws-flabel">{label}</span>
      <div className="mws-input" data-multiline={f.type === 'multiline' ? 'true' : undefined}>
        {f.type === 'choice' ? (
          <>
            <span className="mws-placeholder">
              {biText(f.options[0]?.label, lang) || at('choose', lang)}
            </span>
            <span className="mws-caret" aria-hidden="true" />
          </>
        ) : f.type === 'password' ? (
          <span className="mws-placeholder" dir="ltr">
            ••••••••
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ScreenBody({
  screen,
  spec,
  lang,
  dark,
}: {
  screen: PreviewScreen;
  spec: PreviewSpec;
  lang: Lang;
  dark: boolean;
}) {
  switch (screen.kind) {
    case 'list':
      return screen.items.length === 0 ? (
        <p className="mws-empty">{at('empty', lang)}</p>
      ) : (
        <ul className="mws-list">
          {screen.items.map((i, n) => (
            <li key={n}>
              <span className="mws-avatar" aria-hidden="true">
                {(biText(i.title, lang).trim()[0] ?? '•').toUpperCase()}
              </span>
              <span className="mws-li-text">
                <strong>{biText(i.title, lang)}</strong>
                {i.subtitle && <span>{biText(i.subtitle, lang)}</span>}
              </span>
              <span className="mws-chev" aria-hidden="true" />
            </li>
          ))}
        </ul>
      );
    case 'form':
      return (
        <div className="mws-form">
          {screen.fields.map((f) => (
            <FieldView key={f.id} f={f} lang={lang} />
          ))}
          <div className="mws-btn">{at('submit', lang)}</div>
        </div>
      );
    case 'settings':
      return (
        <div className="mws-settings">
          <p className="mws-h3">{at('language', lang)}</p>
          <div className="mws-seg" aria-hidden="true">
            <span data-on={lang === 'ar' ? 'true' : undefined}>العربية</span>
            <span data-on={lang === 'en' ? 'true' : undefined}>English</span>
          </div>
          <p className="mws-h3">{at('appearance', lang)}</p>
          <div className="mws-seg" aria-hidden="true">
            <span>{at('system', lang)}</span>
            <span data-on={!dark ? 'true' : undefined}>{at('light', lang)}</span>
            <span data-on={dark ? 'true' : undefined}>{at('dark', lang)}</span>
          </div>
          {spec.auth && <div className="mws-btn mws-btn-outline">{at('signOut', lang)}</div>}
        </div>
      );
    default:
      // home and detail: a title and a text body (what the template's info screen shows)
      return (
        <div className="mws-info">
          <p className="mws-h2">{biText(screen.title, lang)}</p>
          {screen.body && <p className="mws-body">{biText(screen.body, lang)}</p>}
        </div>
      );
  }
}

/**
 * The generated screens of a mobile app drawn from its spec in plain HTML and CSS (no Flutter, no script from the design, no embedded page): the app bar, the
 * screen of the selected bottom tab (home, list, form, detail, settings), the bottom navigation from `navigation.tabs`, the theme's primary colour, light or
 * dark, in Arabic (right to left) or English. It is a picture of the design, not the app: it cannot show device behaviour (the notice beside it says so).
 */
export function PhonePreview({
  locale,
  spec,
  device,
  lang,
  dark,
  label,
}: {
  locale: Locale;
  spec: PreviewSpec;
  device: PhoneDevice;
  lang: Lang;
  dark: boolean;
  /** an accessible name for the frame; defaults to "App preview" */
  label?: string;
}) {
  const [current, setCurrent] = useState(spec.navigation.initial);
  useEffect(() => setCurrent(spec.navigation.initial), [spec]);
  const tabs = spec.navigation.tabs
    .map((id) => spec.screens.find((s) => s.id === id))
    .filter((s): s is PreviewScreen => s !== undefined);
  const screen = spec.screens.find((s) => s.id === current) ?? spec.screens[0]!;
  const primary = spec.theme.primary;
  const style = {
    '--m-primary': primary,
    '--m-on-primary': onColor(primary),
    '--m-secondary': spec.theme.secondary ?? primary,
  } as CSSProperties;
  const nodes: ReactNode = (
    <div
      className="mws-screen"
      data-dark={dark ? 'true' : 'false'}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      lang={lang}
      style={style}
    >
      <div className="mws-status" aria-hidden="true">
        <span dir="ltr">9:41</span>
        <span className="mws-status-icons" />
      </div>
      <header className="mws-appbar">
        <span>{biText(screen.title, lang)}</span>
      </header>
      <div className="mws-content" key={screen.id}>
        <ScreenBody screen={screen} spec={spec} lang={lang} dark={dark} />
      </div>
      {tabs.length > 1 && (
        <nav className="mws-tabs" aria-label={t(locale, 'mws.preview.tabs')}>
          {tabs.map((s) => (
            <button
              key={s.id}
              type="button"
              className="mws-tab"
              aria-current={s.id === screen.id ? 'page' : undefined}
              onClick={() => setCurrent(s.id)}
            >
              <span className="mws-tab-pill">
                <KindIcon kind={s.kind} />
              </span>
              <span>{biText(s.title, lang)}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
  return (
    <div
      className="mws-device"
      data-device={device}
      role="group"
      aria-label={label ?? t(locale, 'mws.preview.frame')}
    >
      {nodes}
    </div>
  );
}
