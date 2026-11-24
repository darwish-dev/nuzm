import { isAgentSensitivePath, normalizeToolPath } from '../../paths';
import { projectPathProblem } from '../changeset';
import { analyzeRequirements, unsupportedStacksIn, type AnalyzeOptions } from './analyze';
import { PROFILES } from './profiles';
import { b } from './profiles-core';
import {
  PLAN_LIMITS,
  type ImplementationPlan,
  type ModuleSpec,
  type PlanTask,
  type ProductProfile,
  type RequirementAnalysis,
  type StackOption,
} from './types';

/** The modules a plan contains: the always-on ones, those a recognised feature pulls in, and (transitively) everything they depend on. */
function selectModules(profile: ProductProfile, features: ReadonlySet<string>): ModuleSpec[] {
  const byId = new Map(profile.modules.map((m) => [m.id, m]));
  const chosen = new Set<string>();
  const add = (id: string) => {
    if (chosen.has(id)) return;
    const m = byId.get(id);
    if (!m) return;
    chosen.add(id);
    for (const d of m.dependsOn) add(d);
  };
  for (const m of profile.modules) if (m.feature === null || features.has(m.feature)) add(m.id);
  return profile.modules.filter((m) => chosen.has(m.id));
}

function pickStack(profile: ProductProfile, requested: string | null): { stack: StackOption; reason: 'requested' | 'default' } {
  const found = requested ? profile.stacks.find((s) => s.id === requested) : undefined;
  return found ? { stack: found, reason: 'requested' } : { stack: profile.stacks[0]!, reason: 'default' };
}

const TEST_KINDS = new Set(['backend', 'frontend', 'auth', 'integration', 'schema']);

/**
 * Decomposes an analysed requirement into an ordered, dependency-checked implementation plan. Pure and deterministic: the same analysis always gives the same plan. Tasks carry
 * their files, acceptance criteria and whether a person must approve their output; the final tasks (tests, documentation, review) are added to every plan.
 */
export function buildPlan(analysis: RequirementAnalysis, rawText = ''): ImplementationPlan {
  const profile = PROFILES[analysis.productType];
  const features = new Set([...analysis.features, ...analysis.impliedFeatures]);
  const mods = selectModules(profile, features);
  const { stack, reason } = pickStack(profile, analysis.requestedStack);

  // depth (wave) of each module: 0 without dependencies, else one more than the deepest dependency
  const ids = new Set(mods.map((m) => m.id));
  const depth = new Map<string, number>();
  const visit = (m: ModuleSpec, seen: Set<string>): number => {
    const known = depth.get(m.id);
    if (known !== undefined) return known;
    if (seen.has(m.id)) throw new Error(`dependency cycle at ${m.id}`);
    seen.add(m.id);
    const deps = m.dependsOn.filter((d) => ids.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => visit(mods.find((y) => y.id === x)!, seen))) : 0;
    seen.delete(m.id);
    depth.set(m.id, d);
    return d;
  };
  for (const m of mods) visit(m, new Set());
  const ordered = [...mods].sort((a, c) => depth.get(a.id)! - depth.get(c.id)! || mods.indexOf(a) - mods.indexOf(c));
  const taskId = new Map(ordered.map((m, i) => [m.id, `T${String(i + 1).padStart(2, '0')}`]));

  const tasks: PlanTask[] = ordered.map((m) => ({
    id: taskId.get(m.id)!,
    moduleId: m.id,
    title: m.title,
    kind: m.kind,
    dependsOn: m.dependsOn.filter((d) => ids.has(d)).map((d) => taskId.get(d)!),
    wave: depth.get(m.id)!,
    files: [...m.files],
    acceptance: [...m.acceptance],
    size: m.size,
    approval: m.approval ?? null,
  }));

  const maxWave = tasks.reduce((x, t) => Math.max(x, t.wave), 0);
  const nextId = () => `T${String(tasks.length + 1).padStart(2, '0')}`;
  const buildTasks = tasks.filter((t) => t.kind !== 'docs');
  const testPath = (moduleId: string): string | null => {
    switch (stack.family) {
      case 'node-web':
      case 'node-api':
        return `tests/${moduleId}.spec.ts`;
      case 'flutter':
        return `test/${moduleId.replace(/-/g, '_')}_test.dart`;
      case 'sql':
        return `db/tests/${moduleId}.test.sql`;
      default:
        return null; // static sites and documents have no automated tests to generate
    }
  };
  const testFiles = [...new Set(tasks.filter((t) => TEST_KINDS.has(t.kind)).map((t) => testPath(t.moduleId)).filter((p): p is string => p !== null))];
  let testsId: string | null = null;
  if (testFiles.length) {
    testsId = nextId();
    tasks.push({
      id: testsId,
      moduleId: 'tests',
      title: b('Automated tests', 'الاختبارات الآلية'),
      kind: 'tests',
      dependsOn: buildTasks.map((t) => t.id),
      wave: maxWave + 1,
      files: testFiles,
      acceptance: [b('Each module has a test for success, validation failure and a forbidden caller', 'لكل وحدة اختبار للنجاح وفشل التحقق ومستخدم غير مصرح')],
      size: 3,
      approval: null,
    });
  }
  // a documentation product IS its documents: it gets no second, generic documentation task
  let docsId: string | null = null;
  if (profile.type !== 'docs') {
    docsId = nextId();
    tasks.push({
      id: docsId,
      moduleId: 'docs',
      title: b('Documentation', 'التوثيق'),
      kind: 'docs',
      dependsOn: buildTasks.map((t) => t.id),
      wave: maxWave + 1,
      files: ['README.md', 'docs/architecture.md', 'docs/runbook.md'],
      acceptance: [b('The README explains how to run, test and configure the project', 'يشرح الملف README كيفية التشغيل والاختبار والإعداد')],
      size: 2,
      approval: null,
    });
  }
  const reviewDeps = [testsId, docsId].filter((x): x is string => x !== null);
  tasks.push({
    id: nextId(),
    moduleId: 'review',
    title: b('Final review', 'المراجعة النهائية'),
    kind: 'review',
    dependsOn: reviewDeps.length ? reviewDeps : tasks.map((t) => t.id),
    wave: maxWave + (reviewDeps.length ? 2 : 1),
    files: [],
    acceptance: [b('A review pass found no secrets, no unsafe paths and every acceptance item met', 'مراجعة لم تجد أسراراً ولا مسارات غير آمنة وكل بنود القبول متحققة')],
    size: 2,
    approval: null,
  });

  const approvals = tasks.filter((t) => t.approval).map((t) => ({ taskId: t.id, reason: t.approval! }));
  const risks: ImplementationPlan['risks'] = [];
  for (const name of rawText ? unsupportedStacksIn(rawText) : [])
    risks.push({ code: 'stack_unsupported', text: b(`${name} was asked for but is not generated; ${stack.title.en} is used.`, `طُلب ${name} لكنه غير مدعوم؛ يُستخدم ${stack.title.ar}.`) });
  if (analysis.ambiguities.length)
    risks.push({ code: 'ambiguous_requirement', text: b('The requirement is ambiguous; answer the open questions before generating.', 'المتطلبات غير واضحة؛ أجب عن الأسئلة المفتوحة قبل التوليد.') });
  if (analysis.confidence < 0.3)
    risks.push({ code: 'low_confidence', text: b('Very little of the text could be placed; expect a generic plan.', 'تعذر تحديد معظم النص؛ توقع خطة عامة.') });
  if (analysis.truncated)
    risks.push({ code: 'requirement_truncated', text: b('The requirement text was cut at the length limit.', 'قُصّ نص المتطلبات عند حد الطول.') });
  if (features.has('invoices'))
    risks.push({ code: 'regulated_area', text: b('Invoicing touches tax rules; no compliance is claimed.', 'تمس الفواتير القواعد الضريبية؛ لا يُدَّعى امتثال.') });
  if (features.has('payments') || features.has('subscriptions'))
    risks.push({ code: 'payment_integration', text: b('Payment code runs in test mode only until the owner supplies a provider.', 'يعمل كود الدفع بوضع تجريبي فقط حتى يوفر المالك مزوداً.') });
  if (tasks.length > 30)
    risks.push({ code: 'large_plan', text: b('The plan is large; consider building it in stages.', 'الخطة كبيرة؛ يُنصح بالبناء على مراحل.') });

  const files = new Set(tasks.flatMap((t) => t.files));
  return {
    version: 1,
    productType: analysis.productType,
    locale: analysis.locale,
    stack: { id: stack.id, title: stack.title, parts: [...stack.parts], reason },
    tasks,
    waves: tasks.reduce((x, t) => Math.max(x, t.wave), 0) + 1,
    fileCount: files.size,
    approvals,
    risks,
    effort: tasks.reduce((n, t) => n + t.size, 0),
    analysis: {
      features: analysis.features,
      impliedFeatures: analysis.impliedFeatures,
      questions: analysis.questions,
      ambiguities: analysis.ambiguities,
      notes: analysis.notes,
      confidence: analysis.confidence,
    },
  };
}

/** One call: text in, plan out. */
export function planFromText(text: string, opts: AnalyzeOptions = {}): ImplementationPlan {
  return buildPlan(analyzeRequirements(text, opts), text);
}

export interface PlanProblem {
  at: string;
  message: string;
}
/**
 * The checker every plan must pass, whoever wrote it (this module, or a model later): unique ids, dependencies that exist and run EARLIER (so no cycle), waves consistent with
 * dependencies, bounded sizes, safe relative file paths (never a sensitive file), no duplicate file across tasks, a review last.
 */
export function validatePlan(plan: unknown): { ok: true } | { ok: false; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const p = plan as Partial<ImplementationPlan> | null;
  if (!p || typeof p !== 'object' || p.version !== 1 || !Array.isArray(p.tasks))
    return { ok: false, problems: [{ at: 'plan', message: 'not a version 1 plan' }] };
  if (p.tasks.length === 0 || p.tasks.length > PLAN_LIMITS.maxTasks)
    problems.push({ at: 'tasks', message: `between 1 and ${PLAN_LIMITS.maxTasks} tasks are required` });
  const index = new Map<string, number>();
  p.tasks.forEach((t, i) => {
    if (typeof t?.id !== 'string' || !/^T\d{2,3}$/.test(t.id)) problems.push({ at: `tasks[${i}].id`, message: 'bad task id' });
    else if (index.has(t.id)) problems.push({ at: `tasks[${i}].id`, message: 'duplicate task id' });
    else index.set(t.id, i);
  });
  const seenFiles = new Map<string, string>();
  p.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!t || typeof t !== 'object') return void problems.push({ at, message: 'not an object' });
    for (const d of Array.isArray(t.dependsOn) ? t.dependsOn : []) {
      const di = index.get(d);
      if (di === undefined) problems.push({ at: `${at}.dependsOn`, message: 'depends on an unknown task' });
      else if (di >= i) problems.push({ at: `${at}.dependsOn`, message: 'a task may only depend on an earlier task (no cycles)' });
      else if ((p.tasks![di]!.wave ?? 0) >= (t.wave ?? 0)) problems.push({ at: `${at}.wave`, message: 'wave must be later than every dependency' });
    }
    if (!Number.isInteger(t.size) || t.size < 1 || t.size > 5) problems.push({ at: `${at}.size`, message: 'size is 1 to 5' });
    const files = Array.isArray(t.files) ? t.files : [];
    if (files.length > PLAN_LIMITS.maxFilesPerTask) problems.push({ at: `${at}.files`, message: `at most ${PLAN_LIMITS.maxFilesPerTask} files per task` });
    for (const f of files) {
      const n = normalizeToolPath(f);
      if (!n.ok) problems.push({ at: `${at}.files`, message: 'a file path is not a valid relative path' });
      else if (projectPathProblem(n.path)) problems.push({ at: `${at}.files`, message: 'a file path is reserved or malformed' });
      else if (isAgentSensitivePath(n.path)) problems.push({ at: `${at}.files`, message: 'a file path is a sensitive file' });
      else if (seenFiles.has(n.path) && seenFiles.get(n.path) !== t.moduleId && t.moduleId !== 'docs' && t.moduleId !== 'tests')
        problems.push({ at: `${at}.files`, message: 'a file is owned by two tasks' });
      else seenFiles.set(n.path, t.moduleId);
    }
  });
  const last = p.tasks[p.tasks.length - 1];
  if (last && last.kind !== 'review') problems.push({ at: 'tasks', message: 'the last task must be a review' });
  return problems.length ? { ok: false, problems } : { ok: true };
}
