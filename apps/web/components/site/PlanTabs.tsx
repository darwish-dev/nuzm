'use client';
import { useState } from 'react';
import { Icon } from '@nuzm/ui';
import type { PlanGroupData } from '../../lib/public-service-plans';

/**
 * The plan groups of a service page as tabs (website hosting / web apps / agencies, or just one group), and the cards of the selected tab as a pricing table.
 * The middle card of a trio is highlighted. All the text arrives already in the page's language.
 */
export function PlanTabs({
  groups,
  labels,
}: {
  groups: PlanGroupData[];
  labels: { tabs: string; included: string; runs: string; off: string };
}) {
  const [active, setActive] = useState(groups[0]?.id ?? '');
  const group = groups.find((g) => g.id === active) ?? groups[0];
  if (!group) return null;
  return (
    <div className="pl-group">
      {groups.length > 1 && (
        <div className="pl-tabs" role="tablist" aria-label={labels.tabs}>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              id={`pl-tab-${g.id}`}
              aria-selected={active === g.id}
              aria-controls="pl-panel"
              onClick={() => setActive(g.id)}
            >
              {g.title}
            </button>
          ))}
        </div>
      )}
      <div
        className="pl-grid"
        id="pl-panel"
        role={groups.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={groups.length > 1 ? `pl-tab-${group.id}` : undefined}
        data-count={Math.min(group.cards.length, 4)}
      >
        {group.cards.map((card, i) => {
          const featured = group.cards.length === 3 && i === 1;
          return (
            <article key={card.key} className={`pl-card${featured ? ' is-featured' : ''}`}>
              <h3 className="pl-name">{card.name}</h3>
              {card.sub && <p className="pl-sub">{card.sub}</p>}
              <div className="pl-price">
                <strong>{card.price}</strong>
                <span>{card.unit}</span>
              </div>
              <a
                className={`button pl-button ${featured ? 'button-blue' : 'button-outline'}`}
                href={card.ctaHref}
              >
                {card.ctaLabel}
              </a>
              <p className="pl-fine">{card.fine}</p>
              <div className="pl-block">
                <h4>{labels.included}</h4>
                <ul>
                  {card.features.map((f) => (
                    <li key={f}>
                      <Icon name="check" size={15} />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              {card.runs && (
                <div className="pl-block">
                  <h4>{labels.runs}</h4>
                  <ul dir="ltr">
                    {card.runs.map((r) => (
                      <li key={r.name} className={r.on ? undefined : 'is-off'}>
                        {r.on ? <Icon name="check" size={15} /> : <i aria-hidden="true">–</i>}
                        {r.name}
                        {!r.on && <span className="sr-only">{labels.off}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
