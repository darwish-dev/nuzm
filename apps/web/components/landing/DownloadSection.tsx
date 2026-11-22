import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';

/**
 * Apps section: two panels, 70% desktop (Mac, Windows) and 30% mobile (iOS, Android). The "screens" are drawn
 * markup, an illustration of the product and not a capture. The apps are not published yet, so the buttons say so
 * and point nowhere: no download URL is invented.
 */
type Platform = 'mac' | 'windows' | 'ios' | 'android';

const TEXT = {
  en: {
    desktopEyebrow: 'NUZM FOR DESKTOP',
    desktopTitle1: 'Your dashboard,',
    desktopTitle2: 'one click away.',
    desktopText:
      'Cloud, domains, websites and AI agents in a focused window, right on your desktop.',
    mac: ['Download for Mac', 'macOS 13 or later'],
    windows: ['Download for Windows', 'Windows 10 or later'],
    desktopSoon: 'Desktop apps are coming soon.',
    desktopAlt: 'Illustration of the Nuzm dashboard on a computer',
    mobileEyebrow: 'NUZM ON MOBILE',
    mobileTitle1: 'Your business,',
    mobileTitle2: 'in your pocket.',
    mobileText: 'Check on your sites and approve what matters, wherever you are.',
    ios: ['App Store', 'Download on the'],
    android: ['Google Play', 'Get it on'],
    mobileSoon: 'Mobile apps are coming soon.',
    mobileAlt: 'Illustration of the Nuzm mobile app',
    overview: 'Overview',
    websites: 'Websites',
    domains: 'Domains',
    servers: 'Servers',
    allOnline: 'All online',
    renew: '2 renew soon',
    healthy: 'Healthy',
    traffic: 'Traffic, last 7 days',
    e1: 'Site deployed',
    e2: 'Domain connected',
    e3: 'Agent finished a task',
    morning: 'Good morning',
    wallet: 'Wallet',
    ai: 'AI',
    review: 'Ready for review',
    reviewSub: 'Your agent finished a task',
    amount: 'SAR 1,240.00',
  },
  ar: {
    desktopEyebrow: 'نظم لسطح المكتب',
    desktopTitle1: 'لوحة تحكمك،',
    desktopTitle2: 'على بُعد نقرة.',
    desktopText: 'السحابة والنطاقات والمواقع ووكلاء الذكاء الاصطناعي في نافذة واحدة على سطح مكتبك.',
    mac: ['تحميل لنظام Mac', 'macOS 13 أو أحدث'],
    windows: ['تحميل لنظام Windows', 'Windows 10 أو أحدث'],
    desktopSoon: 'تطبيقات سطح المكتب قريبًا.',
    desktopAlt: 'رسم توضيحي للوحة تحكم نظم على الحاسوب',
    mobileEyebrow: 'نظم على الجوال',
    mobileTitle1: 'أعمالك،',
    mobileTitle2: 'في جيبك.',
    mobileText: 'تابع مواقعك ووافق على ما يهم، أينما كنت.',
    ios: ['App Store', 'حمّل من'],
    android: ['Google Play', 'احصل عليه من'],
    mobileSoon: 'تطبيقات الجوال قريبًا.',
    mobileAlt: 'رسم توضيحي لتطبيق نظم على الجوال',
    overview: 'نظرة عامة',
    websites: 'المواقع',
    domains: 'النطاقات',
    servers: 'الخوادم',
    allOnline: 'كلها تعمل',
    renew: '٢ تجديد قريبًا',
    healthy: 'سليمة',
    traffic: 'الزيارات، آخر ٧ أيام',
    e1: 'تم نشر الموقع',
    e2: 'تم ربط النطاق',
    e3: 'أنهى الوكيل مهمة',
    morning: 'صباح الخير',
    wallet: 'المحفظة',
    ai: 'الذكاء',
    review: 'جاهز للمراجعة',
    reviewSub: 'أنهى وكيلك مهمة',
    amount: '١٬٢٤٠٫٠٠ ر.س',
  },
} as const;

function StoreButton({ kind, text }: { kind: Platform; text: readonly [string, string] }) {
  return (
    <span className="store-button" role="link" aria-disabled="true" data-platform={kind}>
      <span className="store-glyph" aria-hidden="true">
        {kind === 'windows' ? (
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path
              fill="currentColor"
              d="M3 4.5 10.5 3.4v7.2H3zM11.5 3.3 21 2v8.6h-9.5zM3 11.5h7.5v7.1L3 17.5zM11.5 11.5H21V22l-9.5-1.3z"
            />
          </svg>
        ) : kind === 'android' ? (
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path
              fill="currentColor"
              d="M7 9.5h10v7.7a1.3 1.3 0 0 1-1.3 1.3H15v2.3a1.1 1.1 0 0 1-2.2 0v-2.3h-1.6v2.3a1.1 1.1 0 0 1-2.2 0v-2.3h-.7A1.3 1.3 0 0 1 7 17.2zM5.3 9.6a1.1 1.1 0 0 1 2.2 0v5.5a1.1 1.1 0 0 1-2.2 0zm11.2 0a1.1 1.1 0 0 1 2.2 0v5.5a1.1 1.1 0 0 1-2.2 0zM7.2 8.4a4.9 4.9 0 0 1 9.6 0zm3-2.1a.5.5 0 1 0 0-.1zm3.6 0a.5.5 0 1 0 0-.1z"
            />
          </svg>
        ) : (
          <Icon name={kind === 'mac' ? 'desktop' : 'phone'} size={22} />
        )}
      </span>
      <span className="store-text">
        <small>{text[1]}</small>
        <strong>{text[0]}</strong>
      </span>
    </span>
  );
}

export function DownloadSection({ locale = 'en' }: { locale?: Locale }) {
  const d = TEXT[locale === 'ar' ? 'ar' : 'en'];
  return (
    <section id="apps" className="section wrap downloads-section" aria-labelledby="apps-title">
      <article className="download-card download-desktop">
        <div className="download-copy">
          <span className="eyebrow">{d.desktopEyebrow}</span>
          <h2 id="apps-title">
            {d.desktopTitle1}
            <br />
            <em>{d.desktopTitle2}</em>
          </h2>
          <p>{d.desktopText}</p>
          <div className="store-row">
            <StoreButton kind="mac" text={d.mac} />
            <StoreButton kind="windows" text={d.windows} />
          </div>
          <span className="download-soon">{d.desktopSoon}</span>
        </div>
        <div className="desktop-shot" role="img" aria-label={d.desktopAlt}>
          <div className="desk-bar">
            <i />
            <i />
            <i />
            <span>Nuzm</span>
          </div>
          <div className="desk-body">
            <aside className="desk-rail" aria-hidden="true">
              <Icon name="dashboard" size={16} />
              <Icon name="hosting" size={16} />
              <Icon name="domains" size={16} />
              <Icon name="cloud" size={16} />
              <Icon name="sparkle" size={16} />
              <Icon name="wallet" size={16} />
            </aside>
            <div className="desk-main" aria-hidden="true">
              <div className="desk-top">
                <strong>{d.overview}</strong>
                <span className="desk-pill">
                  <Icon name="wallet" size={12} /> {d.amount}
                </span>
              </div>
              <div className="desk-stats">
                <div>
                  <small>{d.websites}</small>
                  <b>6</b>
                  <em>{d.allOnline}</em>
                </div>
                <div>
                  <small>{d.domains}</small>
                  <b>11</b>
                  <em>{d.renew}</em>
                </div>
                <div>
                  <small>{d.servers}</small>
                  <b>3</b>
                  <em>{d.healthy}</em>
                </div>
              </div>
              <div className="desk-grid">
                <div className="desk-chart">
                  <small>{d.traffic}</small>
                  <div className="desk-bars">
                    {[38, 52, 44, 68, 57, 82, 74].map((h, i) => (
                      <span key={i} style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </div>
                <ul className="desk-list">
                  <li>
                    <Icon name="check" size={12} /> {d.e1}
                  </li>
                  <li>
                    <Icon name="globe" size={12} /> {d.e2}
                  </li>
                  <li>
                    <Icon name="sparkle" size={12} /> {d.e3}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </article>

      <article className="download-card download-mobile">
        <div className="download-copy">
          <span className="eyebrow">{d.mobileEyebrow}</span>
          <h2>
            {d.mobileTitle1}
            <br />
            <em>{d.mobileTitle2}</em>
          </h2>
          <p>{d.mobileText}</p>
          <div className="store-row">
            <StoreButton kind="ios" text={d.ios} />
            <StoreButton kind="android" text={d.android} />
          </div>
          <span className="download-soon">{d.mobileSoon}</span>
        </div>
        <div className="phone-shot" role="img" aria-label={d.mobileAlt}>
          <div className="phone-frame" aria-hidden="true">
            <span className="phone-notch" />
            <div className="phone-screen">
              <div className="phone-head">
                <strong>{d.morning}</strong>
                <Icon name="bell" size={14} />
              </div>
              <div className="phone-balance">
                <small>{d.wallet}</small>
                <b>{d.amount}</b>
              </div>
              <div className="phone-tiles">
                <span>
                  <Icon name="hosting" size={15} />
                  {d.websites}
                </span>
                <span>
                  <Icon name="domains" size={15} />
                  {d.domains}
                </span>
                <span>
                  <Icon name="cloud" size={15} />
                  {d.servers}
                </span>
                <span>
                  <Icon name="sparkle" size={15} />
                  {d.ai}
                </span>
              </div>
              <div className="phone-card">
                <Icon name="check" size={13} />
                <span>
                  <b>{d.review}</b>
                  <small>{d.reviewSub}</small>
                </span>
              </div>
              <nav className="phone-tabs">
                <Icon name="dashboard" size={15} />
                <Icon name="projects" size={15} />
                <Icon name="sparkle" size={15} />
                <Icon name="user" size={15} />
              </nav>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
