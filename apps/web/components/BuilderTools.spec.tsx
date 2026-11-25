// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { missingKeys, t, type Locale } from '@nuzm/i18n';
import {
  ChangePreviewPanel,
  MemoryPanel,
  PlanPanel,
  RepairTimeline,
  ReviewPanel,
  RollbackControls,
  type PlanView,
  type PreviewView,
  type RepairReportView,
} from './BuilderTools';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
const preview = (over: Partial<PreviewView> = {}): PreviewView => ({
  ok: true,
  errors: [],
  files: [
    { op: 'modify', path: 'src/a.ts', added: 1, removed: 1, diff: DIFF, diffTruncated: false },
    {
      op: 'add',
      path: 'src/b.ts',
      added: 3,
      removed: 0,
      diff: '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,3 @@\n+x\n+y\n+z\n',
      diffTruncated: true,
    },
  ],
  totals: { files: 2, added: 4, removed: 1 },
  risks: [],
  approval: { required: false, reasons: [] },
  ...over,
});
const plan = (): PlanView => ({
  productType: 'ecommerce',
  stack: {
    title: { en: 'Next.js + NestJS + PostgreSQL', ar: 'Next.js + NestJS + PostgreSQL' },
    parts: [],
    reason: 'default',
  },
  tasks: [
    {
      id: 'T01',
      title: { en: 'Project scaffold', ar: 'هيكل المشروع' },
      kind: 'config',
      dependsOn: [],
      wave: 0,
      files: [],
      acceptance: [{ en: 'Starts locally', ar: 'يعمل محلياً' }],
      approval: null,
    },
    {
      id: 'T02',
      title: { en: 'Database schema', ar: 'مخطط البيانات' },
      kind: 'schema',
      dependsOn: ['T01'],
      wave: 1,
      files: [],
      acceptance: [],
      approval: 'a migration changes the database: a person approves it',
    },
  ],
  waves: 2,
  fileCount: 7,
  approvals: [{ taskId: 'T02', reason: 'a migration changes the database: a person approves it' }],
  risks: [
    {
      code: 'payment_integration',
      text: { en: 'Payment code runs in test mode only.', ar: 'يعمل كود الدفع بوضع تجريبي فقط.' },
    },
  ],
  analysis: {
    questions: [{ id: 'q', text: { en: 'Which payment provider?', ar: 'أي مزود دفع؟' } }],
    ambiguities: [],
    notes: [{ en: 'Invoices: no compliance claim.', ar: 'الفواتير: دون ادعاء امتثال.' }],
    confidence: 0.8,
  },
});
const LOCALES: Locale[] = ['ar', 'en'];

describe('builder tools: translations', () => {
  it('every bt.* key exists in both languages', () => {
    expect(missingKeys().filter((k) => k.startsWith('bt.'))).toEqual([]);
  });
});

describe.each(LOCALES)('ChangePreviewPanel (%s)', (locale) => {
  it('lists changed files, shows the selected diff left-to-right with markers, and switches by keyboard-operable buttons', () => {
    render(<ChangePreviewPanel locale={locale} state="ready" preview={preview()} />);
    expect(
      screen.getByText(t(locale, 'bt.preview.totals', { files: 2, added: 4, removed: 1 })),
    ).toBeTruthy();
    const pre = screen.getByLabelText(t(locale, 'bt.preview.diffOf', { path: 'src/a.ts' }));
    expect(pre.getAttribute('dir')).toBe('ltr');
    expect(pre.querySelector('[data-kind="add"]')!.textContent).toBe('+new');
    expect(pre.querySelector('[data-kind="del"]')!.textContent).toBe('-old');
    const second = screen.getByRole('button', { name: new RegExp('src/b\\.ts') });
    expect(second.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(second);
    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByLabelText(t(locale, 'bt.preview.diffOf', { path: 'src/b.ts' })),
    ).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.preview.truncated'))).toBeTruthy();
  });
  it('shows loading, error and forbidden states, an empty change, and refusal reasons in the page language', () => {
    const { rerender } = render(<ChangePreviewPanel locale={locale} state="loading" />);
    expect(screen.getByRole('status').textContent).toBe(t(locale, 'bt.state.loading'));
    rerender(<ChangePreviewPanel locale={locale} state="error" />);
    expect(screen.getByRole('alert').textContent).toBe(t(locale, 'bt.state.error'));
    rerender(<ChangePreviewPanel locale={locale} state="forbidden" />);
    expect(document.body.textContent).toContain(t(locale, 'bt.state.forbidden'));
    rerender(
      <ChangePreviewPanel
        locale={locale}
        state="ready"
        preview={preview({ files: [], totals: { files: 0, added: 0, removed: 0 } })}
      />,
    );
    expect(screen.getByText(t(locale, 'bt.preview.none'))).toBeTruthy();
    rerender(
      <ChangePreviewPanel
        locale={locale}
        state="ready"
        preview={preview({
          ok: false,
          errors: [{ at: 'ops[0].path', code: 'sensitive_path', message: 'raw server text' }],
        })}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(t(locale, 'bt.err.sensitive_path'));
    expect(screen.getByRole('alert').textContent).not.toContain('raw server text');
  });
  it('a change that needs approval cannot be applied until the person confirms; the confirmation is passed on', () => {
    const onApply = vi.fn();
    render(
      <ChangePreviewPanel
        locale={locale}
        state="ready"
        preview={preview({
          approval: { required: true, reasons: ['deletes_many_files'] },
          risks: [{ code: 'deletes_many_files', message: 'x' }],
        })}
        onApply={onApply}
      />,
    );
    expect(document.body.textContent).toContain(t(locale, 'bt.risk.deletes_many_files'));
    const apply = screen.getByRole('button', {
      name: t(locale, 'bt.preview.apply'),
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(true);
  });
  it('a change without approval rules applies straight away with confirmed=false; a refused preview cannot be applied', () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <ChangePreviewPanel locale={locale} state="ready" preview={preview()} onApply={onApply} />,
    );
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'bt.preview.apply') }));
    expect(onApply).toHaveBeenCalledWith(false);
    rerender(
      <ChangePreviewPanel
        locale={locale}
        state="ready"
        preview={preview({ ok: false, errors: [{ at: 'x', code: 'invalid_op', message: 'm' }] })}
        onApply={onApply}
      />,
    );
    expect(
      (screen.getByRole('button', { name: t(locale, 'bt.preview.apply') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it('never renders diff text as markup', () => {
    const evil = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+<img src=x onerror=alert(1)>\n';
    const { container } = render(
      <ChangePreviewPanel
        locale={locale}
        state="ready"
        preview={preview({
          files: [
            { op: 'modify', path: 'x', added: 1, removed: 1, diff: evil, diffTruncated: false },
          ],
        })}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe.each(LOCALES)('RollbackControls (%s)', (locale) => {
  const versions = [
    { id: 'v3', label: '#3', isHead: true },
    { id: 'v2', label: '#2 — before the cart', isHead: false },
  ];
  it('previews the chosen version, asks for confirmation in a dialog, then rolls back with the confirmation flag', () => {
    const onPick = vi.fn();
    const onRollback = vi.fn();
    const { rerender } = render(
      <RollbackControls
        locale={locale}
        versions={versions}
        previewState="loading"
        onPick={onPick}
        onRollback={onRollback}
      />,
    );
    const go = screen.getByRole('button', {
      name: t(locale, 'bt.roll.preview'),
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v2' } });
    fireEvent.click(go);
    expect(onPick).toHaveBeenCalledWith('v2');
    rerender(
      <RollbackControls
        locale={locale}
        versions={versions}
        previewState="ready"
        preview={preview({ approval: { required: true, reasons: ['large_change'] } })}
        onPick={onPick}
        onRollback={onRollback}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getAllByRole('button', { name: t(locale, 'bt.roll.go') })[0]!);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: t(locale, 'bt.roll.go') }));
    expect(onRollback).toHaveBeenCalledWith('v2', true);
  });
  it('says there is nothing to roll back to when only the head exists', () => {
    render(
      <RollbackControls
        locale={locale}
        versions={[versions[0]!]}
        previewState="ready"
        onPick={() => {}}
        onRollback={() => {}}
      />,
    );
    expect(screen.getByText(t(locale, 'bt.roll.none'))).toBeTruthy();
  });
});

describe.each(LOCALES)('PlanPanel (%s)', (locale) => {
  it('shows stages, tasks in the page language, approvals, notes, questions, risks, the estimate and progress', () => {
    render(
      <PlanPanel
        locale={locale}
        state="ready"
        plan={plan()}
        estimate={{ totalTokens: 120000, costMinor: 450 }}
        progress={{ T01: 'done', T02: 'running' }}
      />,
    );
    expect(screen.getByText(locale === 'ar' ? 'هيكل المشروع' : 'Project scaffold')).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.plan.wave', { n: 2 }))).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.plan.progress', { done: 1, total: 2 }))).toBeTruthy();
    expect(document.body.textContent).toContain(t(locale, 'bt.task.state.done'));
    expect(document.body.textContent).toContain(t(locale, 'bt.task.needsApproval'));
    expect(document.body.textContent).toContain(
      locale === 'ar' ? 'أي مزود دفع؟' : 'Which payment provider?',
    );
    expect(document.body.textContent).toContain(t(locale, 'bt.plan.estimate.note'));
    expect(screen.getByText(t(locale, 'bt.product.ecommerce'))).toBeTruthy();
  });
  it('has loading, error and forbidden states', () => {
    const { rerender } = render(<PlanPanel locale={locale} state="loading" />);
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<PlanPanel locale={locale} state="error" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<PlanPanel locale={locale} state="forbidden" />);
    expect(document.body.textContent).toContain(t(locale, 'bt.state.forbidden'));
  });
});

describe.each(LOCALES)('ReviewPanel (%s)', (locale) => {
  it('lists findings with a text severity, translated message and a left-to-right location; empty and failed summaries', () => {
    const { rerender } = render(
      <ReviewPanel
        locale={locale}
        state="ready"
        summary={{ passed: false, errors: 1, warnings: 1 }}
        findings={[
          {
            severity: 'error',
            code: 'unresolved_import',
            path: 'src/a.ts',
            line: 3,
            message: 'raw',
          },
          {
            severity: 'warning',
            code: 'brand_new_code',
            path: null,
            line: null,
            message: 'fallback text',
          },
        ]}
      />,
    );
    expect(
      screen.getByText(t(locale, 'bt.review.failed', { errors: 1, warnings: 1 })),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(t(locale, 'bt.finding.unresolved_import'));
    expect(document.body.textContent).not.toContain('raw');
    expect(document.body.textContent).toContain('fallback text'); // an unknown code falls back to the server text
    expect(screen.getByText('src/a.ts:3').closest('bdi,span')!.getAttribute('dir')).toBe('ltr');
    rerender(
      <ReviewPanel
        locale={locale}
        state="ready"
        summary={{ passed: true, errors: 0, warnings: 0 }}
        findings={[]}
      />,
    );
    expect(screen.getByText(t(locale, 'bt.review.passed'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.review.none'))).toBeTruthy();
    rerender(<ReviewPanel locale={locale} state="loading" />);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe.each(LOCALES)('RepairTimeline (%s)', (locale) => {
  const report = (over: Partial<RepairReportView> = {}): RepairReportView => ({
    status: 'passed',
    reason: 'passed',
    builds: 4,
    totalOps: 1,
    pendingApproval: 0,
    origin: 'MOCK',
    iterations: [
      {
        n: 1,
        phase: 'typecheck',
        failed: true,
        findings: 0,
        opsApplied: 1,
        diagnostics: [
          {
            kind: 'typescript',
            path: 'src/a.ts',
            line: 1,
            code: 'TS2322',
            message: 'Type mismatch',
          },
        ],
      },
      { n: 2, phase: 'build', failed: false, findings: 0, opsApplied: 0, diagnostics: [] },
    ],
    ...over,
  });
  it('always labels a simulated run as simulated, shows rounds, diagnostics and the outcome', () => {
    render(<RepairTimeline locale={locale} report={report()} />);
    expect(screen.getByText(t(locale, 'bt.build.simulated'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.build.iteration', { n: 1 }))).toBeTruthy();
    expect(screen.getByText('TS2322')).toBeTruthy();
    expect(document.body.textContent).toContain(t(locale, 'bt.build.status.passed'));
  });
  it('a real run has no simulated banner; repairs waiting for approval are announced', () => {
    render(
      <RepairTimeline
        locale={locale}
        report={report({
          origin: 'REAL',
          status: 'stopped',
          reason: 'needs_approval',
          pendingApproval: 11,
        })}
      />,
    );
    expect(document.body.textContent).not.toContain(t(locale, 'bt.build.simulated'));
    expect(document.body.textContent).toContain(t(locale, 'bt.build.pending', { n: 11 }));
    expect(document.body.textContent).toContain(t(locale, 'bt.build.reason.needs_approval'));
  });
});

describe.each(LOCALES)('MemoryPanel (%s)', (locale) => {
  const entries = [
    {
      id: 'm1',
      kind: 'decision' as const,
      text: 'Arabic is the default',
      source: 'user' as const,
      pinned: true,
    },
  ];
  it('shows notes, adds one through the form, removes one, and clears the field', () => {
    const onAdd = vi.fn();
    const onForget = vi.fn();
    render(
      <MemoryPanel
        locale={locale}
        state="ready"
        entries={entries}
        onAdd={onAdd}
        onForget={onForget}
      />,
    );
    expect(document.body.textContent).toContain('Arabic is the default');
    fireEvent.click(
      screen.getByRole('button', {
        name: t(locale, 'bt.mem.forgetNote', { text: 'Arabic is the default' }),
      }),
    );
    expect(onForget).toHaveBeenCalledWith('m1');
    const input = screen.getByLabelText(t(locale, 'bt.mem.text')) as HTMLInputElement;
    const add = screen.getByRole('button', { name: t(locale, 'bt.mem.add') }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Money is in halalas ' } });
    fireEvent.change(screen.getByLabelText(t(locale, 'bt.mem.kind')), {
      target: { value: 'convention' },
    });
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith({
      kind: 'convention',
      text: 'Money is in halalas',
      pinned: false,
    });
    expect(input.value).toBe('');
  });
  it('is read-only without write permission, and has empty/loading/forbidden states', () => {
    const { rerender } = render(
      <MemoryPanel
        locale={locale}
        state="ready"
        entries={entries}
        canWrite={false}
        onAdd={() => {}}
        onForget={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: t(locale, 'bt.mem.add') })).toBeNull();
    rerender(<MemoryPanel locale={locale} state="ready" entries={[]} />);
    expect(screen.getByText(t(locale, 'bt.mem.empty'))).toBeTruthy();
    rerender(<MemoryPanel locale={locale} state="loading" />);
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<MemoryPanel locale={locale} state="forbidden" />);
    expect(document.body.textContent).toContain(t(locale, 'bt.state.forbidden'));
  });
});
