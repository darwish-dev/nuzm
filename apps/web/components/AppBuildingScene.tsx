import { t, type Locale } from '@nuzm/i18n';

/**
 * The preview's loading state while the agents build a WEB APP: a blueprint of its three layers that assemble from the bottom up (the database with its tables, the
 * API with its endpoints, the interface with a dashboard) while data packets travel between them, looping until the run finishes. A different picture from the
 * website's page wireframe because the work is different. Pure CSS, decorative, announced once for screen readers; with reduced motion it is a still blueprint.
 */
export function AppBuildingScene({ locale, label }: { locale: Locale; label: string }) {
  const at = (i: number) => ({ '--i': i }) as React.CSSProperties;
  return (
    <div
      className="bscene ascene"
      role="img"
      aria-label={label || t(locale, 'mws.preview.designing')}
    >
      <span className="bscene-line" aria-hidden="true" />
      <div className="ascene-board" aria-hidden="true">
        <section className="ascene-layer ascene-ui bscene-pop" style={at(4)}>
          <h4>{t(locale, 'm10a.agent.frontend')}</h4>
          <div className="ascene-ui-body">
            <i className="side" />
            <div className="main">
              <div className="kpis">
                <i className="shimmer" />
                <i className="shimmer" />
                <i className="shimmer" />
              </div>
              <div className="rows">
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        </section>
        <div className="ascene-link bscene-pop" style={at(3)}>
          <b />
          <b />
          <b />
        </div>
        <section className="ascene-layer ascene-api bscene-pop" style={at(2)}>
          <h4>{t(locale, 'm10a.agent.backend')}</h4>
          <ul>
            {['GET', 'POST', 'PUT', 'DEL'].map((m, i) => (
              <li key={m} style={{ ['--k' as string]: i }}>
                <em dir="ltr">{m}</em>
                <i />
              </li>
            ))}
          </ul>
        </section>
        <div className="ascene-link bscene-pop" style={at(1)}>
          <b />
          <b />
          <b />
        </div>
        <section className="ascene-layer ascene-db bscene-pop" style={at(0)}>
          <h4>{t(locale, 'm10a.agent.database')}</h4>
          <div className="tables">
            {[0, 1, 2].map((n) => (
              <div key={n} className="table">
                <b />
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
