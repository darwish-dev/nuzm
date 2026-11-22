import { SharedServiceArt } from './SharedServiceArt';

const classes: Record<string, string> = {
  hosting: 'bn-hosting',
  cloud: 'bn-cloud',
  domains: 'bn-domains',
  'ai-builder': 'bn-ai',
  email: 'bn-email',
  data: 'bn-data',
  automation: 'bn-flow',
};
/** Exactly the same illustration markup and materials used on the homepage. */
export function ServiceVisual({ slug }: { slug: string }) {
  return (
    <div className="bn svc-shared-art" aria-hidden="true">
      <div className={`bn-card ${classes[slug] ?? 'bn-ai'}`}>
        <span className="bn-art">
          <SharedServiceArt slug={slug} />
        </span>
      </div>
    </div>
  );
}
