import { Fragment, type ReactNode } from 'react';
import type { Locale } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { GUIDES, doc, type Block } from '../../lib/docs-content';
import { pick } from '../../lib/site-content';
import { REF, curlOf, nodeOf, type ApiOp, type Field } from '../../lib/api-docs';
import { CodeBlock } from './CodeBlock';
import { MobileMenu } from './MobileMenu';

/** Text with `inline code` between backticks. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} dir="ltr">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function Method({ m }: { m: string }) {
  return (
    <span className="doc-method" data-method={m} dir="ltr">
      {m}
    </span>
  );
}

const copyProps = (locale: Locale) => ({
  copyLabel: doc('copy', locale),
  copiedLabel: doc('copied', locale),
});

export function GuideBlocks({ locale, blocks }: { locale: Locale; blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p':
            return (
              <p key={i}>
                <Rich text={pick(b.v, locale)} />
              </p>
            );
          case 'h':
            return (
              <h2 key={i} id={`section-${i}`}>
                {pick(b.v, locale)}
              </h2>
            );
          case 'ul':
            return (
              <ul key={i}>
                {b.v.map((x, j) => (
                  <li key={j}>
                    <Rich text={pick(x, locale)} />
                  </li>
                ))}
              </ul>
            );
          case 'note':
            return (
              <p key={i} className="doc-note" role="note">
                <Icon name="pin" size={15} />
                <span>
                  <Rich text={pick(b.v, locale)} />
                </span>
              </p>
            );
          case 'code':
            return (
              <CodeBlock
                key={i}
                code={b.v}
                label={b.caption ? pick(b.caption, locale) : b.lang}
                {...copyProps(locale)}
              />
            );
          case 'table':
            return (
              <div key={i} className="doc-table-wrap">
                <table className="doc-table">
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} scope="col">
                          {pick(h, locale)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <Rich text={pick(c, locale)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'errors':
            return <ErrorTable key={i} locale={locale} />;
        }
      })}
    </>
  );
}

export function ErrorTable({ locale }: { locale: Locale }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        <thead>
          <tr>
            <th scope="col">{doc('status', locale)}</th>
            <th scope="col">{doc('code', locale)}</th>
            <th scope="col">{doc('meaning', locale)}</th>
          </tr>
        </thead>
        <tbody>
          {REF.errors.map((e) => (
            <tr key={e.code}>
              <td dir="ltr">{e.status}</td>
              <td>
                <code dir="ltr">{e.code}</code>
              </td>
              <td dir="ltr">{e.title}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldRows({ fields, depth = 0 }: { fields: Field[]; depth?: number }) {
  return (
    <>
      {fields.map((f) => (
        <Fragment key={`${depth}-${f.name}`}>
          <tr data-depth={depth}>
            <td className="doc-field-name" style={{ paddingInlineStart: 14 + depth * 18 }}>
              <code dir="ltr">{f.name}</code>
            </td>
            <td dir="ltr" className="doc-field-type">
              {f.type}
              {f.required ? <b> *</b> : null}
            </td>
            <td dir="ltr">{f.description ? <Rich text={f.description} /> : null}</td>
          </tr>
          {f.children ? <FieldRows fields={f.children} depth={depth + 1} /> : null}
        </Fragment>
      ))}
    </>
  );
}

export function FieldsTable({
  locale,
  fields,
  caption,
}: {
  locale: Locale;
  fields: Field[];
  caption: string;
}) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table doc-fields">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{doc('field', locale)}</th>
            <th scope="col">{doc('type', locale)}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          <FieldRows fields={fields} />
        </tbody>
      </table>
    </div>
  );
}

/** The first paragraph of an operation description, then the rest: long descriptions stay readable. */
function Description({ text }: { text: string }) {
  const parts = text.split(/\n{2,}/).filter(Boolean);
  const paras =
    parts.length > 1
      ? parts
      : text.split(/(?<=\.)\s+(?=[A-Z`])/).reduce<string[]>((acc, s) => {
          const last = acc[acc.length - 1];
          if (last !== undefined && last.length < 240) acc[acc.length - 1] = `${last} ${s}`;
          else acc.push(s);
          return acc;
        }, []);
  return (
    <>
      {paras.map((p, i) => (
        <p key={i} dir="ltr">
          <Rich text={p} />
        </p>
      ))}
    </>
  );
}

export function OperationView({ locale, op }: { locale: Locale; op: ApiOp }) {
  const chips: ReactNode[] = [];
  if (op.permission)
    chips.push(
      <span key="p">
        {doc('needs', locale)}: <code dir="ltr">{op.permission}</code>
      </span>,
    );
  if (op.orgScoped) chips.push(<span key="o">{doc('orgScoped', locale)}</span>);
  if (op.idempotencyKey) chips.push(<span key="i">{doc('idem', locale)}</span>);
  if (op.ifMatch) chips.push(<span key="m">{doc('ifMatch', locale)}</span>);
  return (
    <section className="doc-op" id={op.id} aria-labelledby={`${op.id}-h`}>
      <header>
        <h3 id={`${op.id}-h`} dir="ltr">
          <Method m={op.method} />
          <code>{op.path}</code>
        </h3>
        <p className="doc-op-summary" dir="ltr">
          {op.summary}
        </p>
      </header>
      {chips.length > 0 && <p className="doc-chips">{chips}</p>}
      {op.description && op.description !== op.summary && <Description text={op.description} />}
      {op.path_params.length > 0 && (
        <FieldsTable locale={locale} fields={op.path_params} caption={doc('pathParams', locale)} />
      )}
      {op.query.length > 0 && (
        <FieldsTable locale={locale} fields={op.query} caption={doc('queryParams', locale)} />
      )}
      {op.body && op.body.fields.length > 0 && (
        <FieldsTable
          locale={locale}
          fields={op.body.fields}
          caption={`${doc('body', locale)}${op.body.schema ? ` (${op.body.schema})` : ''}`}
        />
      )}
      {op.success && (
        <>
          {op.success.fields.length > 0 ? (
            <FieldsTable
              locale={locale}
              fields={op.success.fields}
              caption={`${doc('response', locale)} ${op.success.code}${op.success.schema ? ` (${op.success.schema})` : ''}`}
            />
          ) : (
            <p className="doc-muted" dir="ltr">
              {doc('response', locale)} {op.success.code}: {op.success.description}
            </p>
          )}
        </>
      )}
      {op.errors.length > 0 && (
        <p className="doc-chips">
          <span>{doc('errorsLabel', locale)}:</span>
          {op.errors.map((c) => (
            <code key={c} dir="ltr">
              {c}
            </code>
          ))}
        </p>
      )}
      <details className="doc-samples">
        <summary>
          {doc('samples', locale)}
          <Icon name="chevron" size={13} />
        </summary>
        <CodeBlock code={curlOf(op)} label="cURL" {...copyProps(locale)} />
        <CodeBlock code={nodeOf(op)} label="Node.js" {...copyProps(locale)} />
      </details>
    </section>
  );
}

/** "On this page" items of a guide: its section headings, in order (the ids are set by GuideBlocks). */
export function guideToc(locale: Locale, blocks: Block[]): { id: string; label: string }[] {
  return blocks.flatMap((b, i) =>
    b.t === 'h' ? [{ id: `section-${i}`, label: pick(b.v, locale) }] : [],
  );
}

/** Left column: the guides, the API areas (a collapsible group, open while reading the reference) and the downloads, with the open page marked. */
export function DocsSidebar({ locale, path }: { locale: Locale; path: string }) {
  const link = (href: string, label: string, extra?: { download?: string }) => (
    <a
      key={href}
      href={`/${locale}${href}`}
      aria-current={path === href ? 'page' : undefined}
      {...(extra?.download ? { download: extra.download } : {})}
    >
      {label}
    </a>
  );
  const inReference = path.startsWith('/docs/reference');
  return (
    <nav className="doc-side" aria-label={doc('docs', locale)}>
      <MobileMenu
        label={
          <>
            <Icon name="menu" size={16} /> {doc('menuLabel', locale)}
          </>
        }
      >
        <p className="doc-side-title">{doc('guidesNav', locale)}</p>
        {link('/docs', doc('docs', locale))}
        {GUIDES.map((g) => link(`/docs/guides/${g.slug}`, pick(g.title, locale)))}
        <p className="doc-side-title">{doc('reference', locale)}</p>
        {link('/docs/reference', doc('apiRef', locale))}
        <details open={inReference}>
          <summary>
            {doc('endpointsTitle', locale)}
            <Icon name="chevron" size={14} />
          </summary>
          {REF.tags.map((t) => link(`/docs/reference/${t.name}`, t.title))}
        </details>
        <p className="doc-side-title">{doc('downloads', locale)}</p>
        {link('/docs/openapi.json', doc('downloadOpenapi', locale), {
          download: 'nuzm-openapi.json',
        })}
        {link('/docs/postman.json', doc('downloadPostman', locale), {
          download: 'nuzm-postman-collection.json',
        })}
      </MobileMenu>
    </nav>
  );
}
