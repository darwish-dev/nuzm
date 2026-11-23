import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';

/**
 * Apps section: 70% desktop (Mac, Windows), 30% mobile (iOS, Android). The screens are captures of the real console
 * (public/landing, demo organization, test data). A desktop installer the server can offer (lib/desktop-downloads.ts) is a real download link with its
 * version and size; any other platform stays "Soon" and points nowhere: no download URL is invented. The installers are not code-signed yet, so the
 * section says how to open them the first time on each system.
 */
type Platform = 'mac' | 'windows' | 'ios' | 'android';
export type DesktopOffer = Partial<
  Record<'mac' | 'windows', { href: string; version: string | null; size: number | null }>
>;

const TEXT = {
  en: {
    desktopEyebrow: 'NUZM FOR DESKTOP',
    desktopTitle: 'Your dashboard, one click away.',
    mac: 'Mac',
    windows: 'Windows',
    mobileEyebrow: 'NUZM ON MOBILE',
    mobileTitle: 'Your business, in your pocket.',
    ios: 'iPhone',
    android: 'Android',
    soon: 'Soon',
    download: 'Download',
    version: 'Version',
    macFor: 'For Mac with Apple silicon or Intel',
    winFor: 'For Windows 10 and 11 (64-bit)',
    firstOpen: 'First time opening?',
    macHelp:
      'The app is not signed by Apple yet. Open the downloaded file, drag Nuzm AI to Applications, then right-click the app and choose Open (or allow it in System Settings → Privacy & Security).',
    winHelp:
      'The installer is not signed yet. If Windows shows “Windows protected your PC”, choose More info, then Run anyway.',
    desktopAlt: 'The Nuzm dashboard',
    mobileAlt: 'The Nuzm dashboard on a phone',
  },
  ar: {
    desktopEyebrow: 'نظم لسطح المكتب',
    desktopTitle: 'لوحة تحكمك، على بُعد نقرة.',
    mac: 'Mac',
    windows: 'Windows',
    mobileEyebrow: 'نظم على الجوال',
    mobileTitle: 'أعمالك، في جيبك.',
    ios: 'iPhone',
    android: 'Android',
    soon: 'قريبًا',
    download: 'تنزيل',
    version: 'الإصدار',
    macFor: 'لأجهزة Mac بمعالجات Apple أو Intel',
    winFor: 'لنظام Windows 10 أو 11 (64 بت)',
    firstOpen: 'أول مرة تفتح التطبيق؟',
    macHelp:
      'التطبيق غير موقَّع من Apple بعد. افتح الملف المنزَّل واسحب Nuzm AI إلى مجلد التطبيقات، ثم انقر عليه بزر الفأرة الأيمن واختر فتح (أو اسمح به من إعدادات النظام ← الخصوصية والأمان).',
    winHelp:
      'المثبّت غير موقَّع بعد. إن ظهرت رسالة «حمى Windows جهازك» فاختر مزيد من المعلومات ثم تشغيل على أي حال.',
    desktopAlt: 'لوحة تحكم نظم',
    mobileAlt: 'لوحة تحكم نظم على الجوال',
  },
} as const;

/** Glyphs without a path use the shared icon set (Mac: a computer, iPhone: a phone). */
const GLYPHS: Record<Platform, string> = {
  mac: '',
  ios: '',
  windows:
    'M3 4.5 10.5 3.4v7.2H3zM11.5 3.3 21 2v8.6h-9.5zM3 11.5h7.5v7.1L3 17.5zM11.5 11.5H21V22l-9.5-1.3z',
  android:
    'M7 9.5h10v7.7a1.3 1.3 0 0 1-1.3 1.3H15v2.3a1.1 1.1 0 0 1-2.2 0v-2.3h-1.6v2.3a1.1 1.1 0 0 1-2.2 0v-2.3h-.7A1.3 1.3 0 0 1 7 17.2zM5.3 9.6a1.1 1.1 0 0 1 2.2 0v5.5a1.1 1.1 0 0 1-2.2 0zm11.2 0a1.1 1.1 0 0 1 2.2 0v5.5a1.1 1.1 0 0 1-2.2 0zM7.2 8.4a4.9 4.9 0 0 1 9.6 0z',
};

const mb = (n: number) => `${Math.round(n / 1_048_576)} MB`;

function Glyph({ kind }: { kind: Platform }) {
  const path = GLYPHS[kind];
  return path ? (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d={path} />
    </svg>
  ) : (
    <Icon name={kind === 'mac' ? 'desktop' : 'phone'} size={18} />
  );
}

/** A store button: a real download when the installer is offered, otherwise a disabled "Soon" (never a made-up link). */
function StoreButton({
  kind,
  label,
  soon,
  tone,
  offer,
  download,
  version,
}: {
  kind: Platform;
  label: string;
  soon: string;
  tone: 'teal' | 'orange';
  offer?: { href: string; version: string | null; size: number | null };
  download?: string;
  version?: string;
}) {
  if (offer)
    return (
      <a
        className={`store-button store-${tone} store-live`}
        href={offer.href}
        download
        data-platform={kind}
      >
        <Glyph kind={kind} />
        <strong>
          {download} {label}
        </strong>
        <small>
          {[
            offer.version ? `${version} ${offer.version}` : null,
            offer.size ? mb(offer.size) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </a>
    );
  return (
    <span className={`store-button store-${tone}`} role="link" aria-disabled="true">
      <Glyph kind={kind} />
      <strong>{label}</strong>
      <small>{soon}</small>
    </span>
  );
}

export function DownloadSection({
  locale = 'en',
  desktop = {},
}: {
  locale?: Locale;
  desktop?: DesktopOffer;
}) {
  const l = locale === 'ar' ? 'ar' : 'en';
  const d = TEXT[l];
  return (
    <section id="apps" className="section wrap downloads-section" aria-labelledby="apps-title">
      <article className="download-card download-desktop">
        <div className="download-copy">
          <span className="eyebrow">{d.desktopEyebrow}</span>
          <h2 id="apps-title">{d.desktopTitle}</h2>
          <div className="store-row">
            <StoreButton
              kind="mac"
              label={d.mac}
              soon={d.soon}
              tone="teal"
              offer={desktop.mac}
              download={d.download}
              version={d.version}
            />
            <StoreButton
              kind="windows"
              label={d.windows}
              soon={d.soon}
              tone="orange"
              offer={desktop.windows}
              download={d.download}
              version={d.version}
            />
          </div>
          {(desktop.mac || desktop.windows) && (
            <details className="download-help">
              <summary>{d.firstOpen}</summary>
              <ul>
                {desktop.mac && (
                  <li>
                    <b>{d.macFor}.</b> {d.macHelp}
                  </li>
                )}
                {desktop.windows && (
                  <li>
                    <b>{d.winFor}.</b> {d.winHelp}
                  </li>
                )}
              </ul>
            </details>
          )}
        </div>
        <div className="desktop-shot">
          <div className="desk-bar" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <img
            src={`/landing/dashboard-desktop-${l}.jpg`}
            alt={d.desktopAlt}
            width={2560}
            height={1880}
            loading="lazy"
          />
        </div>
      </article>

      <article className="download-card download-mobile">
        <div className="download-copy">
          <span className="eyebrow">{d.mobileEyebrow}</span>
          <h2>{d.mobileTitle}</h2>
          <div className="store-row">
            <StoreButton kind="ios" label={d.ios} soon={d.soon} tone="teal" />
            <StoreButton kind="android" label={d.android} soon={d.soon} tone="orange" />
          </div>
        </div>
        <div className="phone-shot">
          <div className="phone-frame">
            <img
              src={`/landing/dashboard-mobile-${l}.jpg`}
              alt={d.mobileAlt}
              width={780}
              height={1688}
              loading="lazy"
            />
          </div>
        </div>
      </article>
    </section>
  );
}
