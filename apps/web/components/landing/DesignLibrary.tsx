'use client';
import { useEffect, useRef, useState } from 'react';
import designs from './design-documents.json';

export function DesignLibrary() {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(Math.min(1, entry.contentRect.width / 1200));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <main
      style={{
        maxWidth: 1200,
        margin: '0 auto',
        padding: '36px 20px',
        fontFamily: 'Manrope, system-ui, sans-serif',
        color: '#22262d',
      }}
    >
      <link rel="stylesheet" href="/fonts/identity/fonts.css" />
      <a href="/" style={{ color: '#4e7880' }}>
        Back to Nuzm
      </a>
      <h1 style={{ fontSize: 36, letterSpacing: '-.04em', marginBottom: 12 }}>
        Your Nuzm design library.
      </h1>
      <p style={{ color: '#5d6870', lineHeight: 1.7 }}>
        Your three attached designs, imported with their original colors, typography, and curves.
      </p>
      <div ref={container}>
        {['software', 'cloud', 'ai'].map((name) => (
          <section key={name} style={{ marginTop: 40 }}>
            <h2 style={{ fontSize: 18, textTransform: 'capitalize' }}>
              {name === 'ai' ? 'AI' : name}
            </h2>
            <div
              style={{
                height: 900 * scale,
                overflow: 'hidden',
                borderRadius: 28,
                boxShadow: '0 12px 32px -18px #22262d40',
              }}
            >
              <iframe
                title={`Nuzm ${name} original design`}
                srcDoc={designs[name as keyof typeof designs]}
                sandbox="allow-same-origin"
                width="1200"
                height="900"
                style={{
                  display: 'block',
                  border: 0,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  background: '#f6f5f1',
                }}
              />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
