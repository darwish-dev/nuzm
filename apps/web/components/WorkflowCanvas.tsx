'use client';
import { useMemo } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge } from '@nuzm/ui';
import { CARD, describeStep, layoutDefinition, type WorkflowDefinition } from '../lib/m11';

/**
 * The step canvas: one card per step, laid out by `layoutDefinition` (a row per depth, a lane per branch) with SVG connectors drawn behind the cards. Plain React and SVG, no graph library.
 * The connectors are decoration (aria-hidden): every card also says where it leads in text, and the cards are an ordered list in reading order, so the graph is fully available to
 * keyboard and screen-reader users. The geometry is always left-to-right (`dir="ltr"` on the board); the text inside a card follows the page language.
 */
export function WorkflowCanvas({
  locale,
  def,
  selected,
  onSelect,
  disabled,
}: {
  locale: Locale;
  def: WorkflowDefinition;
  selected: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const lay = useMemo(() => layoutDefinition(def), [def]);
  const pos = (n: { row: number; lane: number }) => ({
    x: n.lane * (CARD.w + CARD.gapX),
    y: n.row * (CARD.h + CARD.gapY),
  });
  const W = lay.lanes * (CARD.w + CARD.gapX) - CARD.gapX;
  const H = lay.rows * (CARD.h + CARD.gapY) - CARD.gapY;
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  if (def.steps.length === 0)
    return (
      <p className="nz-muted" role="status">
        {t(locale, 'm11.wf.canvas.empty')}
      </p>
    );
  return (
    <div
      role="region"
      aria-label={t(locale, 'm11.wf.canvas.label')}
      tabIndex={0}
      style={{
        overflow: 'auto',
        maxBlockSize: 560,
        border: '1px solid var(--nuzm-color-border)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        dir="ltr"
        style={{ position: 'relative', inlineSize: W, blockSize: H, minInlineSize: 'max-content' }}
      >
        <svg
          width={W}
          height={H}
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute', insetInlineStart: 0, insetBlockStart: 0 }}
        >
          <defs>
            <marker
              id="m11-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {lay.edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const pa = pos(a);
            const pb = pos(b);
            const x1 = pa.x + CARD.w / 2;
            const y1 = pa.y + CARD.h;
            const x2 = pb.x + CARD.w / 2;
            const y2 = pb.y;
            const dy = Math.max(20, (y2 - y1) / 2);
            return (
              <g
                key={`${e.from}>${e.to}`}
                style={{
                  color:
                    e.kind === 'false'
                      ? 'var(--nuzm-color-danger)'
                      : 'var(--nuzm-color-border-strong)',
                }}
              >
                <path
                  d={`M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray={e.kind === 'false' ? '6 4' : undefined}
                  markerEnd="url(#m11-arrow)"
                />
              </g>
            );
          })}
        </svg>
        <ol
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
          aria-label={t(locale, 'm11.wf.canvas.steps')}
        >
          {lay.nodes.map((n, i) => {
            const p = pos(n);
            const s = n.step;
            const sel = selected === n.id;
            const out: string[] = [];
            if (s.type === 'condition') {
              if (s.onTrue) out.push(t(locale, 'm11.wf.canvas.onTrue', { id: s.onTrue }));
              if (s.onFalse) out.push(t(locale, 'm11.wf.canvas.onFalse', { id: s.onFalse }));
            } else if (s.next) out.push(t(locale, 'm11.wf.canvas.next', { id: s.next }));
            return (
              <li
                key={n.id}
                style={{
                  position: 'absolute',
                  insetInlineStart: p.x,
                  insetBlockStart: p.y,
                  inlineSize: CARD.w,
                  blockSize: CARD.h,
                }}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={sel}
                  onClick={() => onSelect(n.id)}
                  dir={locale === 'ar' ? 'rtl' : 'ltr'}
                  style={{
                    inlineSize: '100%',
                    blockSize: '100%',
                    textAlign: 'start',
                    padding: 8,
                    border: `${sel ? 3 : 1}px solid ${sel ? 'var(--nuzm-color-accent-strong)' : 'var(--nuzm-color-border-strong)'}`,
                    borderRadius: 8,
                    background: n.orphan ? 'var(--nuzm-color-surface)' : 'var(--nuzm-color-bg)',
                    color: 'var(--nuzm-color-fg)',
                    font: 'inherit',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    display: 'grid',
                    gap: 2,
                    alignContent: 'start',
                  }}
                >
                  {/* the button is named by its own content (a label that differs from the visible text fails WCAG 2.5.3); the step number is part of that content */}
                  <span className="nz-sr">{t(locale, 'm11.wf.canvas.step', { n: i + 1 })}</span>
                  <span className="nz-row" style={{ gap: 6 }}>
                    <Badge>{tDynamic(locale, `m11.wf.type.${s.type}`, s.type)}</Badge>
                    {def.start === n.id && (
                      <Badge tone="success">{t(locale, 'm11.wf.canvas.start')}</Badge>
                    )}
                    {n.orphan && <Badge tone="warn">{t(locale, 'm11.wf.canvas.orphan')}</Badge>}
                  </span>
                  <strong
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    <bdi dir="auto">{s.name || s.id}</bdi>
                  </strong>
                  <span
                    className="nz-muted"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: '.8rem',
                    }}
                  >
                    <bdi dir="auto">{describeStep(s) || out.join(' · ')}</bdi>
                  </span>
                  {describeStep(s) && out.length > 0 && (
                    <span
                      className="nz-muted"
                      style={{
                        fontSize: '.75rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <bdi dir="auto">{out.join(' · ')}</bdi>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
