import { Icon, type IconName } from '@nuzm/ui';

/** Editable artwork adapted from the supplied Nuzm bento pack. No live telemetry. */
export function ServiceArtwork({
  service,
  ar,
  compact = false,
}: {
  service: string;
  ar: boolean;
  compact?: boolean;
}) {
  const steps: { icon: IconName; text: string }[] = [
    { icon: 'code', text: ar ? 'خطط' : 'Plan' },
    { icon: 'projects', text: ar ? 'ابنِ' : 'Build' },
    { icon: 'check', text: ar ? 'انشر' : 'Ship' },
  ];
  return (
    <div
      className={`nzc-service-art nb-art${compact ? ' nb-art-compact' : ''}`}
      data-service={service}
      aria-hidden="true"
    >
      {service === 'hosting' ? (
        <div className="nb-process-stack">
          <div className="nb-stack-sheet nb-sheet-back" />
          <div className="nb-stack-sheet nb-sheet-middle" />
          <div className="nb-process-sheet">
            {steps.map((step, index) => (
              <div className="nb-process-step" key={step.text}>
                <span>
                  <Icon name={step.icon} size={19} />
                  {step.text}
                </span>
                {index < 2 && <span className="nb-down">↓</span>}
              </div>
            ))}
          </div>
        </div>
      ) : service === 'compute' ? (
        <div className="nb-cluster-stack">
          <div className="nb-stack-sheet nb-sheet-back" />
          <div className="nb-stack-sheet nb-sheet-middle" />
          <div className="nb-cluster-sheet">
            <div className="nb-widget-heading">
              <span>NUZM CLOUD</span>
              <Icon name="cloud" size={17} />
            </div>
            <div className="nb-resource-grid">
              {[
                { icon: 'hosting' as const, text: ar ? 'الحوسبة' : 'Compute' },
                { icon: 'data' as const, text: ar ? 'البيانات' : 'Data' },
                { icon: 'projects' as const, text: ar ? 'الموارد' : 'Resources' },
              ].map((item) => (
                <span key={item.icon}>
                  <Icon name={item.icon} size={23} />
                  <span>{item.text}</span>
                </span>
              ))}
            </div>
            <svg className="nb-wave" viewBox="0 0 280 48" fill="none">
              <defs>
                <linearGradient
                  id={compact ? 'nb-fill-small' : 'nb-fill-large'}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop stopColor="currentColor" stopOpacity=".22" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0 40C25 40 32 15 54 21S86 41 106 28 137 8 158 19 194 32 217 16 252 7 280 11V48H0Z"
                fill={`url(#${compact ? 'nb-fill-small' : 'nb-fill-large'})`}
              />
              <path
                className="nb-wave-line"
                d="M0 40C25 40 32 15 54 21S86 41 106 28 137 8 158 19 194 32 217 16 252 7 280 11"
                stroke="currentColor"
                strokeWidth="2.5"
              />
            </svg>
          </div>
        </div>
      ) : service === 'builder' ? (
        <div className="nb-editor">
          <div className="nb-editor-top">
            <span>
              <i />
              <i />
              <i />
            </span>
            <span>your-next-idea.ts</span>
          </div>
          <pre>
            <span>const</span>
            {' project = await nuzm.build({\n  idea: '}
            <b>"Something great"</b>
            {',\n  platform: '}
            <b>"web"</b>
            {'\n});\n'}
            <span>await</span>
            {' project.publish();'}
          </pre>
        </div>
      ) : (
        <div className="nb-domain-scene">
          <div className="nb-globe">
            <Icon name="domains" size={118} />
          </div>
          <div className="nb-domain-sheet">
            <span className="nb-widget-heading">{ar ? 'عنوانك القادم' : 'YOUR NEXT ADDRESS'}</span>
            <strong dir="ltr">
              yourbrand<span>.sa</span>
            </strong>
            <div className="nb-domain-tags">
              <span>.com</span>
              <span>.sa</span>
              <span>.net</span>
            </div>
          </div>
          <span className="nb-dns-tag">
            <Icon name="shield" size={13} /> DNS
          </span>
        </div>
      )}
    </div>
  );
}
