'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { landingText } from '../../lib/landing-text';

const options: { label: string; icon: IconName; href: string }[] = [
  { label: 'Mobile app', icon: 'phone', href: '/mobile/new' },
  { label: 'Website', icon: 'globe', href: '/builder/projects' },
  { label: 'Dashboard', icon: 'dashboard', href: '/builder/apps' },
];

/** Only the selected, visible preview runs; manual interactions restart its timer. */
function usePreview(on: boolean, initial = 0) {
  const [view, setView] = useState(initial);
  useEffect(() => {
    if (!on || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      const section = document.getElementById('agents');
      const bounds = section?.getBoundingClientRect();
      if (
        !document.hidden &&
        bounds &&
        bounds.top < innerHeight * 0.7 &&
        bounds.bottom > innerHeight * 0.3
      ) {
        setView((current) => (current + 1) % 3);
      }
    }, 5200);
    return () => window.clearInterval(timer);
  }, [on, view]);
  return [view, setView] as const;
}

function Spark({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 80 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Phone({ on }: { on: boolean }) {
  const [view, setView] = usePreview(on);
  const [booked, setBooked] = useState(false);
  return (
    <span className="cx-phone-body cx-health" data-view={view} {...(on ? {} : { inert: true })}>
      <span className="cx-island" />
      {view === 0 && (
        <>
          <span className="cx-health-greeting">
            <i className="cx-patient" />
            <Icon name="calendar" size={13} />
            <small>Good morning,</small>
            <strong>Sara Wilson</strong>
          </span>
          <button className="cx-appointment" onClick={() => setView(2)}>
            <small>Your next appointment</small>
            <strong>08</strong>
            <span>
              May 2026, Thursday
              <br />
              10:30 AM
            </span>
            <Icon name="calendar" size={36} />
          </button>
          <span className="cx-vitals">
            <b>
              Health overview <small>This week⌄</small>
            </b>
            <span>
              {[
                ['Heart rate', '72', 'bpm'],
                ['Blood pressure', '120/80', 'mmHg'],
                ['Oxygen level', '98', '%'],
              ].map(([label, value, unit]) => (
                <span key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                  <small>
                    {unit} <Icon name="pulse" size={11} />
                  </small>
                </span>
              ))}
            </span>
          </span>
          <span className="cx-health-access">
            <b>Quick access</b>
            <span>
              {(
                [
                  ['Find doctor', 'user'],
                  ['Symptoms', 'pulse'],
                  ['Medicines', 'shield'],
                  ['Lab tests', 'data'],
                ] as [string, IconName][]
              ).map(([label, icon]) => (
                <button key={label} onClick={() => setView(1)}>
                  <i>
                    <Icon name={icon} size={15} />
                  </i>
                  <small>{label}</small>
                </button>
              ))}
            </span>
          </span>
          <span className="cx-health-note">
            <Icon name="check" size={12} />
            <span>
              Your health, in good hands.<small>Next checkup in 6 days</small>
            </span>
          </span>
        </>
      )}
      {view === 1 && (
        <>
          <span className="cx-health-title">
            <small>CARE, MADE PERSONAL</small>
            <strong>
              Find the right
              <br />
              treatment.
            </strong>
          </span>
          <button className="cx-treatment-search" onClick={() => setView(2)}>
            <Icon name="search" size={12} />
            Search treatments, doctors…
          </button>
          <button className="cx-treatment-feature" onClick={() => setView(2)}>
            <span className="cx-medical-photo cx-mri" />
            <span>
              <b>Advanced imaging</b>
              <small>MRI, CT, X-Ray</small>
              <i>↗</i>
            </span>
          </button>
          <span className="cx-treatment-tiles">
            {['Vaccination', 'Specialist care'].map((label, i) => (
              <button key={label} onClick={() => setView(2)}>
                <span className={`cx-medical-photo cx-care-${i}`} />
                <b>{label}</b>
                <i>↗</i>
              </button>
            ))}
          </span>
          <button className="cx-specialist" onClick={() => setView(2)}>
            <b>Talk to a specialist</b>
            <small>Expert advice, when you need it.</small>
            <span>↗</span>
          </button>
        </>
      )}
      {view === 2 && (
        <>
          <span className="cx-treatment-cover cx-medical-photo cx-clinic" />
          <span className="cx-treatment-detail">
            <small>PERSONALIZED CARE</small>
            <strong>Specialist consultation</strong>
            <span>
              4.9 ★ <small>(240 reviews)</small>
            </span>
            <span className="cx-care-perks">
              <span>
                <Icon name="user" size={14} />
                Expert doctors
              </span>
              <span>
                <Icon name="shield" size={14} />
                Trusted care
              </span>
              <span>
                <Icon name="support" size={14} />
                24/7 support
              </span>
            </span>
            <b>Your care, your way.</b>
            <p>Meet your specialist and find a treatment plan built around you.</p>
          </span>
          <button className="cx-booking" onClick={() => setBooked(!booked)}>
            <span>
              <b>{booked ? 'Appointment confirmed' : 'Book consultation'}</b>
              <small>{booked ? 'May 08 · 10:30 AM' : 'From $150'}</small>
            </span>
            <Icon name={booked ? 'check' : 'chevron'} size={16} />
          </button>
        </>
      )}
      <span className="cx-tabbar">
        {(
          [
            ['Home', 'dashboard'],
            ['Treatments', 'calendar'],
            ['Booking', 'user'],
          ] as [string, IconName][]
        ).map(([label, icon], i) => (
          <button
            key={label}
            type="button"
            aria-pressed={view === i}
            aria-label={`Mobile preview: ${label}`}
            onClick={() => setView(i)}
          >
            <Icon name={icon} size={15} />
            {view === i && <span>{label}</span>}
          </button>
        ))}
      </span>
    </span>
  );
}

const products = [
  {
    name: 'Daily Body Cream',
    note: 'Cream · Fragrance-free',
    price: 28,
    format: 'Cream',
    x: 11.5,
    y: 15.375,
  },
  {
    name: 'Barrier Repair Cream',
    note: 'Cream · Fragrance-free',
    price: 34,
    format: 'Cream',
    x: 20,
    y: 15.375,
  },
  {
    name: 'Citrus Body Balm',
    note: 'Balm · Citrus',
    price: 22,
    format: 'Balm',
    x: 28.2,
    y: 15.375,
  },
  {
    name: 'Whipped Shea Cream',
    note: 'Cream · Citrus',
    price: 32,
    format: 'Cream',
    x: 36.7,
    y: 15.375,
  },
  {
    name: 'Night Recovery Balm',
    note: 'Balm · Fragrance-free',
    price: 26,
    format: 'Balm',
    x: 11.5,
    y: 23.6,
  },
  {
    name: 'Oat Soothing Cream',
    note: 'Cream · Fragrance-free',
    price: 30,
    format: 'Cream',
    x: 20,
    y: 23.6,
  },
  { name: 'Mineral Body Balm', note: 'Balm · Citrus', price: 24, format: 'Balm', x: 28.2, y: 23.6 },
  {
    name: 'Cloud Body Cream',
    note: 'Cream · Fragrance-free',
    price: 36,
    format: 'Cream',
    x: 36.7,
    y: 23.6,
  },
];
function ProductPhoto({ product }: { product: (typeof products)[number] }) {
  return (
    <span
      className="cx-product-photo"
      role="img"
      aria-label={product.name}
      style={{ backgroundPosition: `-${product.x}em -${product.y}em` }}
    />
  );
}
function Site({ on }: { on: boolean }) {
  const [filter, setFilter] = useState('All');
  const [bag, setBag] = useState(0);
  const [sort, setSort] = useState(false);
  const [demo] = usePreview(on);
  const shown = products.filter((p) => filter === 'All' || p.format === filter);
  if (sort) shown.sort((a, b) => a.price - b.price);
  return (
    <span className="cx-shop" {...(on ? {} : { inert: true })}>
      <span className="cx-shop-nav">
        <b>Hollis.</b>
        <span>Shop</span>
        <strong>Body Care</strong>
        <span>Daily Essentials</span>
        <span>Accessories</span>
        <em key={bag}>
          Bag <b>{bag}</b>
        </em>
      </span>
      <span className="cx-shop-hero">
        <small>Shop / Body Care</small>
        <strong>Body Care</strong>
        <span>Everyday rituals. Exceptionally made.</span>
        <span className="cx-shop-feature">
          <ProductPhoto product={products[demo % 3]!} />
        </span>
      </span>
      <span className="cx-shop-layout">
        <span className="cx-shop-filters">
          <b>Filters</b>
          <small>Format</small>
          {['All', 'Cream', 'Balm'].map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
              <span>{f === 'All' ? 8 : f === 'Cream' ? 5 : 3}</span>
            </button>
          ))}
          <small>Scent</small>
          <span>Fragrance-free</span>
          <span>Citrus</span>
          <small>Price</small>
          {['Under $20', '$20 to $30', '$30 to $40'].map((p, i) => (
            <span key={p}>
              {p}
              <i style={{ width: `${70 - i * 15}%` }} />
            </span>
          ))}
          <small>Availability</small>
          <span>
            In stock <i className="cx-stock-toggle" />
          </span>
        </span>
        <span className="cx-shop-catalog">
          <span className="cx-shop-toolbar">
            <small>{shown.length} products</small>
            <button aria-pressed={sort} onClick={() => setSort(!sort)}>
              Sort by: {sort ? 'Price ↑' : 'Featured'}⌄
            </button>
          </span>
          <span className="cx-product-grid" key={filter + sort}>
            {shown.map((p) => (
              <span className="cx-product" key={p.name}>
                <ProductPhoto product={p} />
                <b>{p.name}</b>
                <small>{p.note}</small>
                <span>
                  <strong>${p.price}</strong>
                  <small>In stock</small>
                  <button aria-label={`Add ${p.name} to bag`} onClick={() => setBag(bag + 1)}>
                    +
                  </button>
                </span>
              </span>
            ))}
          </span>
        </span>
      </span>
      <span className="cx-shop-toast" key={`${bag}-${demo}`}>
        <Icon name="check" size={11} />
        {bag ? `${bag} item${bag === 1 ? '' : 's'} in your bag` : 'Thoughtful care. Delivered.'}
      </span>
    </span>
  );
}

function App({ on }: { on: boolean }) {
  const [view, setView] = usePreview(on);
  const nav: [string, IconName][] = [
    ['Overview', 'dashboard'],
    ['Pipeline', 'workflow'],
    ['Activity', 'pulse'],
  ];
  return (
    <span className="cx-app" data-view={view} {...(on ? {} : { inert: true })}>
      <span className="cx-side">
        <b>
          <i /> Finexy
        </b>
        {nav.map(([n, ic], i) => (
          <button key={n} type="button" aria-pressed={view === i} onClick={() => setView(i)}>
            <Icon name={ic} size={15} />
            {n}
          </button>
        ))}
      </span>
      <span className="cx-main">
        <span className="cx-top">
          <b>{view === 0 ? 'Good morning, Layla' : nav[view]![0]}</b>
          <span className="cx-search">
            <Icon name="search" size={13} /> Search
          </span>
          <i className="cx-avatar">LO</i>
        </span>
        {view === 0 && (
          <>
            <span className="cx-balance">
              <small>Total balance</small>
              <strong>
                $689,372<span>.00</span>
              </strong>
              <span>
                <em>↗ 5%</em> from last month
              </span>
              <button onClick={() => setView(2)}>
                View transactions <Icon name="chevron" size={10} />
              </button>
            </span>
            <span className="cx-kpis">
              {[
                ['Earnings', '$950', 'M0 20 C12 18 18 8 30 12 S52 4 80 2'],
                ['Spending', '$700', 'M0 14 C14 16 22 6 36 10 S60 14 80 4'],
                ['Income', '$1,050', 'M0 18 C16 12 26 14 40 8 S64 6 80 3'],
              ].map(([l, v, d]) => (
                <span key={l}>
                  <small>{l}</small>
                  <b>{v}</b>
                  <Spark d={d!} />
                </span>
              ))}
            </span>
            <span className="cx-finance-bottom">
              <span className="cx-income">
                <b>Total income</b>
                <small>Your income over time</small>
                <span className="cx-income-bars">
                  {[46, 76, 56, 91, 65, 82, 70].map((v, i) => (
                    <span key={i}>
                      <i style={{ height: `${v}%` }} />
                      <small>{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'][i]}</small>
                    </span>
                  ))}
                </span>
              </span>
              <span className="cx-credit">
                <small>
                  My card <Icon name="grid" size={11} />
                </small>
                <strong>finexy.</strong>
                <span>•••• •••• •••• 6782</span>
                <b>
                  LAYLA OMAR <small>09/29</small>
                </b>
              </span>
            </span>
            <span className="cx-recent">
              <b>
                Recent activities <span>This month</span>
              </b>
              {[
                ['Mobile app purchase', '$2,550', 'Completed'],
                ['Hotel booking', '$327', 'Pending'],
              ].map(([name, amount, status]) => (
                <span key={name}>
                  <Icon name="basket" size={11} />
                  <strong>{name}</strong>
                  <small>{amount}</small>
                  <em>{status}</em>
                </span>
              ))}
            </span>
          </>
        )}
        {view === 1 && (
          <span className="cx-pipeline">
            {[
              {
                title: 'New lead',
                total: 'SAR 84,000',
                deals: [
                  ['Forma Studio', 'Website redesign', '32,000', 'FS'],
                  ['Palm Hotels', 'Guest experience', '52,000', 'PH'],
                ],
              },
              {
                title: 'Proposal',
                total: 'SAR 96,000',
                deals: [
                  ['Madar Group', 'Customer portal', '68,000', 'MG'],
                  ['Qahwa', 'Mobile ordering', '28,000', 'QA'],
                ],
              },
              {
                title: 'Won',
                total: 'SAR 68,000',
                deals: [['Nova Retail', 'Commerce platform', '68,000', 'NR']],
              },
            ].map((column) => (
              <span className="cx-deal-column" key={column.title}>
                <b>
                  <i />
                  {column.title}
                </b>
                <small>{column.total}</small>
                {column.deals.map(([name, project, amount, initials]) => (
                  <span className="cx-deal" key={name}>
                    <i className="cx-avatar">{initials}</i>
                    <b>{name}</b>
                    <small>{project}</small>
                    <strong>SAR {amount}</strong>
                    <span>
                      <Icon name="calendar" size={10} /> Follow up today
                    </span>
                  </span>
                ))}
              </span>
            ))}
          </span>
        )}
        {view === 2 && (
          <span className="cx-people">
            {[
              ['Layla A.', 82],
              ['Omar K.', 64],
              ['Sara M.', 47],
              ['Nora H.', 31],
            ].map(([n, p]) => (
              <span key={String(n)}>
                <i className="cx-avatar">{String(n).slice(0, 1)}</i>
                {n}
                <u>
                  <s style={{ inlineSize: `${p}%` }} />
                </u>
              </span>
            ))}
          </span>
        )}
        <small className="cx-sample">Sample data</small>
      </span>
    </span>
  );
}

export function AiBuildShowcase({ locale = 'en' }: { locale?: Locale }) {
  const d = landingText(locale);
  const [active, setActive] = useState(1);
  const devices: ReactNode[] = [
    <Phone key="p" on={active === 0} />,
    <Site key="s" on={active === 1} />,
    <App key="a" on={active === 2} />,
  ];
  return (
    <section id="agents" className="section wrap cx-section" aria-labelledby="cx-title">
      <div className="cx-heading">
        <span className="eyebrow">{d.showEyebrow}</span>
        <h2 id="cx-title">
          {d.showTitle1}
          <br />
          <em>{d.showTitle2}</em>
        </h2>
        <p>{d.showText}</p>
        <a className="button button-blue cx-create" href={options[active]!.href}>
          {d.showCreate[active]}
          <Icon name="sparkle" size={16} />
        </a>
      </div>
      <div className="cx-stage" role="group" aria-label={d.showStage}>
        <div className="cx-glow" aria-hidden="true" />
        {options.map((o, i) => (
          <div
            key={o.label}
            className={`cx-device cx-device-${i} cx-position-${(i - active + 3) % 3}${active === i ? ' is-on' : ''}`}
            onClick={() => setActive(i)}
          >
            <button
              type="button"
              className="cx-label"
              aria-pressed={active === i}
              onClick={() => setActive(i)}
            >
              <Icon name={o.icon} size={16} />
              {d.showOptions[i]}
            </button>
            <span className={`cx-frame cx-frame-${i}`}>{devices[i]}</span>
          </div>
        ))}
        <span className="cx-badge">
          <Icon name="sparkle" size={16} /> {d.showBadge}
        </span>
      </div>
      <div className="cx-bottom">
        <div className="cx-picker" role="group" aria-label={d.showPicker}>
          {options.map((o, i) => (
            <button
              key={o.label}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={active === i}
            >
              {d.showOptions[i]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
