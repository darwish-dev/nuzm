const LOGOS: { name: string; src?: string; badge?: { bg: string; fg: string; text: string } }[] = [
  { name: 'React', src: '/brand/technologies/react.svg' },
  { name: 'Next.js', src: '/brand/technologies/nextjs.svg' },
  { name: 'NestJS', src: '/brand/technologies/nestjs.svg' },
  { name: 'Flutter', src: '/brand/technologies/flutter.svg' },
  { name: 'PHP', src: '/brand/technologies/php.svg' },
  { name: 'TypeScript', badge: { bg: '#3178c6', fg: '#fff', text: 'TS' } },
  { name: 'JavaScript', badge: { bg: '#f7df1e', fg: '#1b1b1b', text: 'JS' } },
];

/**
 * The technologies Nuzm builds and hosts, as a slow sliding strip under the hero. The list is shown twice in a row and the track moves by exactly one list, so the
 * loop has no seam; hovering pauses it and reduced motion stops it. The second copy is hidden from assistive technology.
 */
export function TechStrip({
  label = 'Technologies you can build and run on Nuzm',
}: {
  label?: string;
}) {
  const group = (hidden: boolean) => (
    <ul className="tech-group" aria-hidden={hidden || undefined}>
      {[...LOGOS, ...LOGOS].map((l, i) => (
        <li key={`${l.name}-${i}`} className="tech-item">
          <span className="tech-logo">
            {l.src ? (
              <img src={l.src} alt="" width={26} height={26} loading="lazy" />
            ) : (
              <svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true">
                <rect width="26" height="26" rx="4" fill={l.badge?.bg} />
                <text
                  x="23"
                  y="23"
                  textAnchor="end"
                  fontFamily="Manrope, Arial, sans-serif"
                  fontWeight="800"
                  fontSize="11"
                  fill={l.badge?.fg}
                >
                  {l.badge?.text}
                </text>
              </svg>
            )}
          </span>
          <span className="tech-name">{l.name}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="tech-strip" role="group" aria-label={label}>
      <div className="tech-track">
        {group(false)}
        {group(true)}
      </div>
    </div>
  );
}
