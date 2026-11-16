import type { ComponentProps, ReactNode } from 'react';

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
}
export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
}) {
  return (
    <div className="nz-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="nz-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
