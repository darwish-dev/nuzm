import { Icon } from '@nuzm/ui';

/**
 * Apps section: two panels, 70% desktop (Mac, Windows) and 30% mobile (iOS, Android). The "screens" are drawn
 * markup, an illustration of the product and not a capture. The apps are not published yet, so the buttons say so
 * and point nowhere: no download URL is invented.
 */
const stores = {
  mac: 'Mac',
  windows: 'Windows',
  ios: 'iPhone & iPad',
  android: 'Android',
} as const;

function StoreButton({
  kind,
  label,
  sub,
}: {
  kind: keyof typeof stores;
  label: string;
  sub: string;
}) {
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
        <small>{sub}</small>
        <strong>{label}</strong>
      </span>
    </span>
  );
}

export function DownloadSection() {
  return (
    <section id="apps" className="section wrap downloads-section" aria-labelledby="apps-title">
      <article className="download-card download-desktop">
        <div className="download-copy">
          <span className="eyebrow">NUZM FOR DESKTOP</span>
          <h2 id="apps-title">
            Your dashboard,
            <br />
            <em>one click away.</em>
          </h2>
          <p>Cloud, domains, websites and AI agents in a focused window, right on your desktop.</p>
          <div className="store-row">
            <StoreButton kind="mac" label="Download for Mac" sub="macOS 13 or later" />
            <StoreButton kind="windows" label="Download for Windows" sub="Windows 10 or later" />
          </div>
          <span className="download-soon">Desktop apps are coming soon.</span>
        </div>
        <div
          className="desktop-shot"
          role="img"
          aria-label="Illustration of the Nuzm dashboard on a computer"
        >
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
                <strong>Overview</strong>
                <span className="desk-pill">
                  <Icon name="wallet" size={12} /> SAR 1,240.00
                </span>
              </div>
              <div className="desk-stats">
                <div>
                  <small>Websites</small>
                  <b>6</b>
                  <em>All online</em>
                </div>
                <div>
                  <small>Domains</small>
                  <b>11</b>
                  <em>2 renew soon</em>
                </div>
                <div>
                  <small>Servers</small>
                  <b>3</b>
                  <em>Healthy</em>
                </div>
              </div>
              <div className="desk-grid">
                <div className="desk-chart">
                  <small>Traffic, last 7 days</small>
                  <div className="desk-bars">
                    {[38, 52, 44, 68, 57, 82, 74].map((h, i) => (
                      <span key={i} style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </div>
                <ul className="desk-list">
                  <li>
                    <Icon name="check" size={12} /> Site deployed
                  </li>
                  <li>
                    <Icon name="globe" size={12} /> Domain connected
                  </li>
                  <li>
                    <Icon name="sparkle" size={12} /> Agent finished a task
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </article>

      <article className="download-card download-mobile">
        <div className="download-copy">
          <span className="eyebrow">NUZM ON MOBILE</span>
          <h2>
            Your business,
            <br />
            <em>in your pocket.</em>
          </h2>
          <p>Check on your sites and approve what matters, wherever you are.</p>
          <div className="store-row">
            <StoreButton kind="ios" label="App Store" sub="Download on the" />
            <StoreButton kind="android" label="Google Play" sub="Get it on" />
          </div>
          <span className="download-soon">Mobile apps are coming soon.</span>
        </div>
        <div className="phone-shot" role="img" aria-label="Illustration of the Nuzm mobile app">
          <div className="phone-frame" aria-hidden="true">
            <span className="phone-notch" />
            <div className="phone-screen">
              <div className="phone-head">
                <strong>Good morning</strong>
                <Icon name="bell" size={14} />
              </div>
              <div className="phone-balance">
                <small>Wallet</small>
                <b>SAR 1,240.00</b>
              </div>
              <div className="phone-tiles">
                <span>
                  <Icon name="hosting" size={15} />
                  Sites
                </span>
                <span>
                  <Icon name="domains" size={15} />
                  Domains
                </span>
                <span>
                  <Icon name="cloud" size={15} />
                  Servers
                </span>
                <span>
                  <Icon name="sparkle" size={15} />
                  AI
                </span>
              </div>
              <div className="phone-card">
                <Icon name="check" size={13} />
                <span>
                  <b>Ready for review</b>
                  <small>Your agent finished a task</small>
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
