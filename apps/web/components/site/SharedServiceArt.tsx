import { AiChatArtwork } from './AiChatArtwork';
import { Icon } from '@nuzm/ui';

/** Single source for homepage and service-page product illustrations. */
export function SharedServiceArt({ slug }: { slug: string }) {
  switch (slug) {
    case 'hosting':
      return (
        <>
          <>
            <span className="bn-browser" dir="ltr">
              <span className="bn-browser-top">
                <i />
                <i />
                <i />
                <b>
                  <Icon name="lock" size={11} /> your-site.com
                </b>
              </span>
              <span className="bn-browser-body">
                <span className="bn-lines">
                  <i />
                  <i />
                  <i />
                  <u>
                    <Icon name="send" size={13} /> Publish
                  </u>
                </span>
                <span className="bn-hero-block">
                  <Icon name="globe" size={38} />
                </span>
              </span>
            </span>
            <span className="bn-rack" dir="ltr">
              {[0, 1, 2].map((n) => (
                <span key={n}>
                  <i />
                  <b />
                </span>
              ))}
            </span>
            <span className="bn-runtimes" dir="ltr">
              <b>Static</b>
              <b>PHP</b>
              <b>Node.js</b>
              <b>Python</b>
            </span>
          </>
        </>
      );
    case 'cloud':
      return (
        <>
          <span className="bn-cluster" dir="ltr">
            <span className="bn-cluster-tiles">
              <span>
                <Icon name="cloud" size={22} />
                <i />
              </span>
              <span>
                <Icon name="data" size={22} />
                <i />
              </span>
              <span>
                <Icon name="dashboard" size={22} />
                <i />
              </span>
            </span>
            <svg viewBox="0 0 320 70" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="bn-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity=".32" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                className="bn-area"
                d="M0 54 C28 48 40 16 70 28 S112 58 138 34 S178 10 202 26 S244 52 268 20 S300 24 320 8 V70 H0Z"
              />
              <path
                className="bn-line"
                d="M0 54 C28 48 40 16 70 28 S112 58 138 34 S178 10 202 26 S244 52 268 20 S300 24 320 8"
              />
            </svg>
          </span>
        </>
      );
    case 'domains':
      return (
        <>
          <span className="bn-domain-box" dir="ltr">
            <span className="bn-search">
              <Icon name="search" size={18} />
              <b>
                yourbrand<em>.com</em>
              </b>
              <u>
                <Icon name="check" size={14} />
              </u>
            </span>
            <span className="bn-result">
              <Icon name="globe" size={16} />
              <i />
              <span className="bn-chip">
                <Icon name="shield" size={13} /> DNS
              </span>
            </span>
          </span>
        </>
      );
    case 'ai-builder':
      return <AiChatArtwork />;
    case 'email':
      return (
        <>
          <span className="bn-inbox" dir="ltr">
            {[0, 1, 2].map((n) => (
              <span key={n} className={n === 0 ? 'is-on' : undefined}>
                <em>{n === 0 ? <Icon name="mail" size={15} /> : null}</em>
                {n === 0 ? <b>hello@yourbrand.com</b> : <i />}
                <i />
              </span>
            ))}
          </span>
        </>
      );
    case 'data':
      return (
        <>
          <span className="bn-db" dir="ltr">
            <span className="bn-storage-tower">
              {[0, 1, 2].map((n) => (
                <span key={n}>
                  <Icon name={n === 1 ? 'data' : 'hosting'} size={23} />
                  <span>
                    <i />
                    <i />
                    <i />
                  </span>
                  <b />
                </span>
              ))}
            </span>
            <span className="bn-restore">
              <Icon name="refresh" size={16} />
              <span>
                <b>Backup</b>
                <i />
              </span>
            </span>
          </span>
        </>
      );
    case 'automation':
      return (
        <>
          <span className="bn-nodes" dir="ltr">
            <span>
              <Icon name="grid" size={24} />
            </span>
            <i />
            <span className="is-core">
              <Icon name="refresh" size={30} />
            </span>
            <i />
            <span>
              <Icon name="check" size={25} />
            </span>
          </span>
        </>
      );
    default:
      return null;
  }
}
