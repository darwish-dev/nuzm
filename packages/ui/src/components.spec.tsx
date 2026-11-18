// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Field,
  ForbiddenState,
  Input,
  Ltr,
  NavList,
  PageTitle,
  Shell,
  Skeleton,
  Table,
} from './components';

afterEach(cleanup);

/** axe-core in jsdom (colour contrast needs a real browser, so that rule is checked in the browser pass). */
async function violations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`);
}

describe('accessible building blocks', () => {
  it('shell has a skip link, a labelled nav, a main landmark and marks the current page', async () => {
    const { container, getByRole } = render(
      <div lang="ar" dir="rtl">
        <Shell
          brand={<a href="/ar">نظم</a>}
          nav={
            <NavList
              items={[
                { href: '/ar', label: 'الرئيسية', current: true },
                { href: '/ar/x', label: 'الأعضاء' },
              ]}
            />
          }
          navLabel="التنقل الرئيسي"
          skipLabel="تخطَّ إلى المحتوى"
        >
          <PageTitle>الرئيسية</PageTitle>
        </Shell>
      </div>,
    );
    expect(getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeTruthy();
    expect(getByRole('main')).toBeTruthy();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('الرئيسية');
    expect(container.querySelector('a.nz-skip')?.getAttribute('href')).toBe('#main');
    expect(await violations(container)).toEqual([]);
  });

  it('form fields are labelled and link help/error text for assistive tech', async () => {
    const { container, getByLabelText, getByRole } = render(
      <form>
        <Field id="email" label="Email" help="We never share it" error="Required">
          {(a) => <Input type="email" {...a} />}
        </Field>
        <Button type="submit">Save</Button>
      </form>,
    );
    const input = getByLabelText('Email');
    expect(input.getAttribute('aria-describedby')).toBe('email-help email-err');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(getByRole('alert').textContent).toBe('Required');
    expect(await violations(container)).toEqual([]);
  });

  it('table has a caption and column headers with scope', async () => {
    const { container, getByRole } = render(
      <Table
        caption="Members"
        columns={[
          { key: 'n', header: 'Name', render: (r: { n: string }) => r.n },
          {
            key: 'e',
            header: 'Email',
            render: (r: { n: string }) => <Ltr>{r.n}@example.test</Ltr>,
          },
        ]}
        rows={[{ n: 'layla' }]}
        rowKey={(r) => r.n}
      />,
    );
    expect(getByRole('table', { name: 'Members' })).toBeTruthy();
    expect(container.querySelectorAll('th[scope="col"]')).toHaveLength(2);
    expect(container.querySelector('bdi')?.getAttribute('dir')).toBe('ltr'); // emails stay LTR inside RTL text
    expect(await violations(container)).toEqual([]);
  });

  it('shows cards by default, with a Manage link per row, and switches to the table for every table', async () => {
    const { container, getAllByRole, getByRole } = render(
      <div>
        <Table
          caption="Sites"
          columns={[{ key: 'n', header: 'Name', render: (r: { n: string }) => r.n }]}
          rows={[{ n: 'shop' }, { n: 'blog' }]}
          rowKey={(r) => r.n}
          rowHref={(r) => `/en/sites/${r.n}`}
          manageLabel="Manage"
        />
        <Table
          caption="Plans"
          columns={[{ key: 'n', header: 'Name', render: (r: { n: string }) => r.n }]}
          rows={[{ n: 'starter' }]}
          rowKey={(r) => r.n}
        />
      </div>,
    );
    const wraps = container.querySelectorAll('.nz-table-wrap');
    expect(Array.from(wraps).map((w) => w.getAttribute('data-view'))).toEqual(['cards', 'cards']);
    expect(getAllByRole('link', { name: 'Manage' }).map((a) => a.getAttribute('href'))).toEqual([
      '/en/sites/shop',
      '/en/sites/blog',
    ]);
    // a read-only table has no Manage column
    expect(wraps[1]!.querySelector('.nz-manage-col')).toBeNull();
    // one switch changes every table and is remembered
    act(() => getAllByRole('button', { name: 'Show as a table' })[0]!.click());
    expect(Array.from(wraps).map((w) => w.getAttribute('data-view'))).toEqual(['table', 'table']);
    expect(localStorage.getItem('nuzm.tableView')).toBe('table');
    expect(getByRole('table', { name: 'Sites' })).toBeTruthy();
    localStorage.clear();
    expect(await violations(container)).toEqual([]);
  });

  it('empty / error / forbidden / loading states announce themselves', async () => {
    const { container } = render(
      <div>
        <EmptyState title="Nothing" body="Soon" />
        <ErrorState
          title="Oops"
          body="Try again"
          detail="trace-abc"
          action={<Button>Retry</Button>}
        />
        <ForbiddenState title="No access" body="Ask the owner" />
        <Skeleton label="Loading" />
        <Banner tone="warn">Suspended</Banner>
        <Badge tone="success">Active</Badge>
      </div>,
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector('bdi.nz-ltr')?.textContent).toBe('trace-abc');
    expect(await violations(container)).toEqual([]);
  });
});
