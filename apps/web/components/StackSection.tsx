import type { ReactNode } from 'react';

/**
 * One section of a page that stacks several screens under each other (account, team, organization, privacy). Its `id` is the anchor
 * the old per-screen routes redirect to. A screen rendered inside keeps its own page title, which is hidden here: the section heading
 * names it instead.
 */
export function StackSection({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="nz-card nzc-stack-section" aria-labelledby={`${id}-h`}>
      <div className="nzc-stack-head">
        <h2 className="nz-h2" id={`${id}-h`}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The page heading and the stacked sections below it. */
export function StackPage({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="nzc-pagehead">
        <div>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      <div className="nzc-stack">{children}</div>
    </>
  );
}
