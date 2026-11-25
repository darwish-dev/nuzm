import type { ComponentProps, ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { ManageText, TableViewToggle } from './table-view';

/** Presentational, server-safe components. Text always comes from the caller (packages/i18n); none hold state. */

export function Shell(props: {
  brand: ReactNode;
  topbar?: ReactNode;
  nav: ReactNode;
  navLabel: string;
  skipLabel: string;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <a className="nz-skip" href="#main">
        {props.skipLabel}
      </a>
      {props.banner}
      <div className="nz-shell">
        <header className="nz-top">
          {props.brand}
          <span className="nz-grow" />
          {props.topbar}
        </header>
        <nav className="nz-nav" aria-label={props.navLabel}>
          {props.nav}
        </nav>
        <main className="nz-main" id="main" tabIndex={-1}>
          {props.children}
        </main>
      </div>
    </>
  );
}

export function NavList({
  items,
}: {
  items: { href: string; label: string; current?: boolean }[];
}) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i.href}>
          <a href={i.href} aria-current={i.current ? 'page' : undefined}>
            {i.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export const PageTitle = ({ children }: { children: ReactNode }) => (
  <h1 className="nz-h1">{children}</h1>
);
export const Card = ({ children, ...p }: ComponentProps<'section'>) => (
  <section className="nz-card" {...p}>
    {children}
  </section>
);

export function Button({
  variant = 'primary',
  ...p
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button className="nz-btn" data-variant={variant} type="button" {...p} />;
}
export function ButtonLink({
  variant = 'primary',
  ...p
}: ComponentProps<'a'> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <a className="nz-btn" data-variant={variant} {...p} />;
}

export function Field(props: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  children: (a: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const desc = [props.help && `${props.id}-help`, props.error && `${props.id}-err`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="nz-field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children({
        id: props.id,
        'aria-describedby': desc || undefined,
        'aria-invalid': props.error ? true : undefined,
      })}
      {props.help && (
        <span className="nz-help" id={`${props.id}-help`}>
          {props.help}
        </span>
      )}
      {props.error && (
        <span className="nz-error-text" id={`${props.id}-err`} role="alert">
          {props.error}
        </span>
      )}
    </div>
  );
}
export const Input = (p: ComponentProps<'input'>) => <input className="nz-input" {...p} />;
export const Select = (p: ComponentProps<'select'>) => <select className="nz-input" {...p} />;

export function Badge({
  tone,
  children,
}: {
  tone?: 'success' | 'danger' | 'warn';
  children: ReactNode;
}) {
  return (
    <span className="nz-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Shown beside the label when the table is in card view. */
  icon?: IconName;
  /**
   * Where the cell goes on a card (card view only; the table view is unchanged): the bold `title`, a small `subtitle` above it,
   * the `badge` in the top corner, small `chip`s, `meta` lines, or the `footer` value beside the Manage button.
   */
  card?: 'title' | 'subtitle' | 'badge' | 'chip' | 'meta' | 'footer';
}
/**
 * A data table that shows as CARDS by default (each row a card: the first column is its title, the others label/value pairs) with a
 * switch to the classic table, remembered per browser. Both views are the same <table> restyled, so assistive technology and tests
 * see one table either way. `rowHref` adds a Manage button to every row.
 */
export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowHref,
  manageLabel,
  cardIcon,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  /** Where a row's Manage button leads (omit for read-only tables). */
  rowHref?: (r: T) => string | undefined;
  /** The Manage button's text (defaults to the page language's word for "Manage"). */
  manageLabel?: string;
  /** The icon in each card's corner (cards with roles: see `Column.card`). */
  cardIcon?: IconName;
}) {
  // a table whose columns say where they go on a card gets the richer card layout; others keep label/value cards
  const rich = !!cardIcon || columns.some((c) => c.card);
  const role = (c: Column<T>, i: number) =>
    c.card ?? (rich ? (i === 0 ? 'title' : 'meta') : undefined);
  return (
    <div
      className="nz-table-wrap"
      data-view="cards"
      data-manage={rowHref ? 'true' : undefined}
      data-card={rich ? 'rich' : undefined}
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <TableViewToggle />
      <table className="nz-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
            {rowHref && (
              <th scope="col" className="nz-manage-col">
                <span className="nz-sr-only">
                  <ManageText label={manageLabel} />
                </span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = rowHref?.(r);
            return (
              <tr key={rowKey(r)}>
                {cardIcon && (
                  // decorative: only drawn in card view
                  <td className="nz-card-icon" aria-hidden="true">
                    <span>
                      <Icon name={cardIcon} size={22} />
                    </span>
                  </td>
                )}
                {columns.map((c, i) => (
                  <td key={c.key} data-label={c.header || undefined} data-card={role(c, i)}>
                    {/* the card view's label; the table view (and assistive tech, via the header row) uses <th> instead */}
                    {c.header && (
                      <span className="nz-cell-label" aria-hidden="true">
                        {c.icon && <Icon name={c.icon} size={15} />}
                        {c.header}
                      </span>
                    )}
                    {(() => {
                      const v = c.render(r);
                      // an empty value stays empty (no lone icon), so the card can leave the chip out
                      const has = v !== null && v !== undefined && v !== false && v !== '';
                      return (
                        <span className="nz-cell-value">
                          {has &&
                            rich &&
                            c.icon &&
                            (c.card === 'chip' || role(c, i) === 'meta') && (
                              <Icon name={c.icon} size={14} />
                            )}
                          {v}
                        </span>
                      );
                    })()}
                  </td>
                ))}
                {rowHref && (
                  <td className="nz-manage-col">
                    {href ? (
                      <a className="nz-manage-link" href={href}>
                        <ManageText label={manageLabel} />
                        <Icon name="arrow" size={15} />
                      </a>
                    ) : null}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A read-only on/off value drawn as a switch next to its text (the text keeps it readable for everyone). */
export function OnOff({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="nzc-onoff" data-on={on ? 'true' : 'false'}>
      {children}
    </span>
  );
}

/** Empty / error / forbidden / suspended panels: every data screen renders one of these instead of a blank page. */
function State(props: {
  role?: 'status' | 'alert';
  title: string;
  body: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="nz-state" role={props.role ?? 'status'}>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      {props.detail && (
        <p className="nz-muted">
          <Ltr>{props.detail}</Ltr>
        </p>
      )}
      {props.action}
    </div>
  );
}
export const EmptyState = (p: { title: string; body: string; action?: ReactNode }) => (
  <State {...p} />
);
export const ErrorState = (p: {
  title: string;
  body: string;
  detail?: string;
  action?: ReactNode;
}) => <State {...p} role="alert" />;
export const ForbiddenState = (p: { title: string; body: string }) => <State {...p} role="alert" />;

export function Skeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="nz-skeleton" style={{ inlineSize: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) {
  return (
    <div className="nz-banner" data-tone={tone} role="status">
      {children}
    </div>
  );
}

/** Numbers, emails, ids and URLs stay left-to-right inside RTL text. */
export const Ltr = ({ children }: { children: ReactNode }) => (
  <bdi className="nz-ltr" dir="ltr">
    {children}
  </bdi>
);

/** Native `<meter>` (announced by screen readers with its label); `value` is a 0..100 percentage. */
export function Meter({ label, percent }: { label: string; percent: number }) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <meter className="nz-meter" min={0} max={100} value={v} aria-label={label}>
      {v}%
    </meter>
  );
}

/**
 * Horizontal bars for a small series. The bars are decoration (aria-hidden): the label and the exact value are text, so the
 * chart carries the same information for assistive technology and in print.
 */
export function Bars({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; label: ReactNode; value: ReactNode; ratio: number }[];
}) {
  return (
    <ul className="nz-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span>{r.label}</span>
          <span className="nz-bar" aria-hidden="true">
            <span style={{ inlineSize: `${Math.max(2, Math.min(100, r.ratio * 100))}%` }} />
          </span>
          <span>{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
