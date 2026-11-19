import { t, type Locale } from '@nuzm/i18n';

/**
 * The preview's loading state while the AI is writing the site: a wireframe page whose sections appear one after another, with a shimmer on the pictures and a
 * glow that travels from block to block, looping until the run finishes. Pure CSS (no script, nothing read from the project), decorative for sighted users and
 * announced once as "building your site" for screen readers; with reduced motion it is a still wireframe.
 */
export function BuildingScene({ locale, label }: { locale: Locale; label: string }) {
  const at = (i: number) => ({ '--i': i }) as React.CSSProperties;
  return (
    <div className="bscene" role="img" aria-label={label || t(locale, 'bld.card.working')}>
      <span className="bscene-line" aria-hidden="true" />
      <div className="bscene-window" aria-hidden="true">
        <div className="bscene-chrome">
          <span />
          <span />
          <span />
          <b />
        </div>
        <div className="bscene-page">
          <div className="bscene-nav bscene-pop" style={at(0)}>
            <i className="logo" />
            <i />
            <i />
            <i />
            <i className="cta" />
          </div>
          <div className="bscene-hero bscene-pop" style={at(1)}>
            <div className="bscene-copy">
              <i className="t1" />
              <i className="t2" />
              <i className="p" />
              <i className="p short" />
              <i className="btn" />
            </div>
            <div className="bscene-img shimmer" />
          </div>
          <div className="bscene-cards bscene-pop" style={at(3)}>
            <div className="shimmer" />
            <div className="shimmer" />
            <div className="shimmer" />
          </div>
          <div className="bscene-wide bscene-pop shimmer" style={at(4)} />
          <div className="bscene-foot bscene-pop" style={at(5)}>
            <i />
            <i />
            <i />
          </div>
        </div>
        <span className="bscene-glow" />
      </div>
    </div>
  );
}
