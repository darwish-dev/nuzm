import { t, type Locale } from '@nuzm/i18n';

/** The widget tree the scene "writes": Flutter class names are code, not interface text, so they are not translated. [name, depth] */
const TREE: [string, number][] = [
  ['Scaffold', 0],
  ['AppBar', 1],
  ['ListView', 1],
  ['Card', 2],
  ['Card', 2],
  ['NavigationBar', 1],
];

/**
 * The preview's loading state while the agents design a MOBILE (Flutter) app: a phone whose screen is assembled piece by piece (app bar, banner, list, tab bar)
 * next to the widget tree that is "written" in step with it, looping until the run finishes. Pure CSS, decorative, announced once for screen readers; with
 * reduced motion it is a still phone.
 */
export function MobileBuildingScene({ locale, label }: { locale: Locale; label: string }) {
  const at = (i: number) => ({ '--i': i }) as React.CSSProperties;
  return (
    <div
      className="bscene mscene"
      role="img"
      aria-label={label || t(locale, 'mws.preview.designing')}
    >
      <span className="bscene-line" aria-hidden="true" />
      <div className="mscene-stage" aria-hidden="true">
        <div className="mscene-tree" dir="ltr">
          <span className="mscene-chip">Flutter</span>
          <ul>
            {TREE.map(([name, depth], i) => (
              <li
                key={`${name}-${i}`}
                className="bscene-pop"
                style={{ ...at(i + 1), ['--d' as string]: depth }}
              >
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </div>
        <div className="mscene-phone">
          <i className="notch" />
          <div className="screen">
            <div className="status">
              <i />
              <i />
            </div>
            <div className="appbar bscene-pop" style={at(2)}>
              <i />
              <b />
            </div>
            <div className="banner bscene-pop" style={at(3)}>
              <i className="shimmer" />
            </div>
            <div className="list">
              {[4, 5].map((n) => (
                <div key={n} className="row bscene-pop" style={at(n)}>
                  <span className="avatar shimmer" />
                  <span className="lines">
                    <i />
                    <i />
                  </span>
                </div>
              ))}
            </div>
            <div className="tabbar bscene-pop" style={at(6)}>
              <i className="on" />
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
