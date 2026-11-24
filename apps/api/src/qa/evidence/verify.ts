import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { scanForSecrets } from '@nuzm/domain';
import { SchemaSet, type Schema } from './json-schema';

/**
 * P3-S08 evidence verifier. One record = one JSON file under `docs/phase3/EVIDENCE/<track>/<YYYY-MM-DD>-<id>.json` (schema `nuzm.p3-evidence/1`, see
 * `docs/phase3/EVIDENCE/README.md`). A record is ACCEPTED only when ALL of these hold; every failure is reported, none is hidden:
 *   1. it validates against the envelope schema and against the schema of its track (`details`);
 *   2. `contentHash` equals the recomputed sha256 of its canonical JSON, and every `outputs[].path` file exists and hashes to `sha256`;
 *   3. its labels are consistent: a `LIVE-VERIFIED` record carries no SIMULATED token anywhere, a SIMULATED / NOT VERIFIED record carries no LIVE-VERIFIED
 *      token anywhere, and no record carries both (the "mixed labels" rule: a simulated result can never be promoted to a real one by copying);
 *   4. a `LIVE-VERIFIED` record names the approvals that allowed it, the real identity that ran it, passes every check with a LIVE-VERIFIED label, is within
 *      its cost maximum, and has real (not offline/simulated) components only;
 *   5. a record that is not PASS carries its blockers; the file name and directory agree with the record (track, date, id); ids are unique;
 *   6. the secret scanner finds nothing in the text and no e-mail address that is not a reserved example one appears (never customer data in evidence).
 * Nothing here calls the network or a process; it only reads files.
 */
export const ENVELOPE_ID = 'nuzm.p3-evidence/1';
export const TRACKS = [
  'provider',
  'tool-calling',
  'codegen',
  'runtime',
  'build-repair',
  'preview',
  'deploy',
  'benchmark',
  'mobile',
  'website',
  'fullstack',
  'security',
] as const;
export type Track = (typeof TRACKS)[number];
export type Label = 'SIMULATED' | 'LIVE-VERIFIED' | 'NOT VERIFIED';

export interface EvidenceRecord {
  schema: string;
  id: string;
  track: Track;
  targets: string[];
  component: string;
  label: Label;
  result: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_VERIFIED';
  recordedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  revision: { commit: string; branch?: string };
  components: {
    name: string;
    version: string;
    origin: 'real' | 'simulated' | 'offline';
    label: string;
  }[];
  identity?: Record<string, Record<string, string>>;
  approvals: { id: string; ref: string; recordedIn: string }[];
  inputs: { name: string; sha256: string; bytes?: number; path?: string }[];
  outputs: { name: string; sha256: string; bytes?: number; path?: string }[];
  cost: {
    currency: string;
    unit: string;
    usedMinor: string;
    maxMinor: string;
    priceSource?: string;
  };
  checks: { id: string; label: Label; result: 'PASS' | 'FAIL' | 'NOT_VERIFIED'; detail?: string }[];
  blockers: { id: string; text: string }[];
  details: Record<string, unknown>;
  contentHash: string;
}

export interface Problem {
  rule: string;
  where: string;
  message: string;
}
export interface Verified {
  file: string;
  ok: boolean;
  problems: Problem[];
  record: EvidenceRecord | null;
}

/* ───────────────────────── helpers ───────────────────────── */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');
/** the hash a record must carry: sha256 of its canonical JSON without `contentHash` */
export function computeContentHash(record: Record<string, unknown>): string {
  const { contentHash: _omit, ...rest } = record;
  void _omit;
  return sha256Hex(canonicalJson(rest));
}
/** set `contentHash` (used by tooling that writes evidence: the harness and the tests' fixtures) */
export function seal<T extends Record<string, unknown>>(record: T): T & { contentHash: string } {
  return { ...record, contentHash: computeContentHash(record) };
}

export function repoRoot(start = process.cwd()): string {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, 'pnpm-workspace.yaml'))) return d;
    const p = dirname(d);
    if (p === d) throw new Error('repository root (pnpm-workspace.yaml) not found');
    d = p;
  }
}
export const evidenceDir = (root = repoRoot()): string => join(root, 'docs/phase3/EVIDENCE');

export function loadSchemas(root = repoRoot()): SchemaSet {
  const dir = join(evidenceDir(root), 'schemas');
  const all: Schema[] = readdirSync(dir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Schema);
  return new SchemaSet(all);
}
export const trackSchemaId = (track: string): string => `nuzm.p3-evidence/track/${track}/1`;

/* ───────────────────────── label analysis ───────────────────────── */
const SIM_VALUES = new Set([
  'SIMULATED',
  'OFFLINE_MOCK_REPLAY',
  'OFFLINE_REFERENCE_ORACLE',
  'MOCK',
  'TWIN',
  'SCRIPTED',
  'STUB',
]);
const LIVE_VALUES = new Set(['LIVE-VERIFIED', 'LIVE']);
const LABEL_KEYS = new Set(['label', 'evidenceLabel', 'verdict', 'mode', 'origin', 'kind']);
export interface LabelTokens {
  simulated: string[];
  live: string[];
}
/** every place in the record that says "this is simulated" or "this is live", wherever it is nested. */
export function labelTokens(v: unknown, path = ''): LabelTokens {
  const out: LabelTokens = { simulated: [], live: [] };
  const visit = (x: unknown, p: string, key: string | null): void => {
    if (Array.isArray(x)) return x.forEach((e, i) => visit(e, `${p}/${i}`, null));
    if (x !== null && typeof x === 'object') {
      for (const [k, val] of Object.entries(x as Record<string, unknown>))
        visit(val, `${p}/${k}`, k);
      return;
    }
    if (key === 'simulated' && x === true) out.simulated.push(`${p}=true`);
    if (key === 'productionKeyUsed') return;
    if (typeof x === 'string' && key !== null && LABEL_KEYS.has(key)) {
      const u = x.toUpperCase();
      if (SIM_VALUES.has(u) || u === 'SIMULATED') out.simulated.push(`${p}=${x}`);
      if (LIVE_VALUES.has(u)) out.live.push(`${p}=${x}`);
    }
  };
  visit(v, path, null);
  return out;
}
const FAKE_IDENTITY =
  /\b(mock|twin|scripted|fake|stub|simulat\w*|in-memory|localhost-stand-in|reference-oracle)\b/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const RESERVED_MAIL = /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/i;

/* ───────────────────────── record verification ───────────────────────── */
export interface VerifyContext {
  schemas: SchemaSet;
  /** absolute path of the directory the record file lives in (for `outputs[].path`); null for in-memory records */
  dir: string | null;
  /** how the file is named: `<track dir>/<file>`; null for in-memory records (skips the placement rule) */
  placement: { trackDir: string; fileName: string } | null;
  readFile?: (abs: string) => Buffer | null;
}
const DEFAULT_READ = (abs: string): Buffer | null => (existsSync(abs) ? readFileSync(abs) : null);

export function verifyRecord(raw: unknown, ctx: VerifyContext, file = '(memory)'): Verified {
  const problems: Problem[] = [];
  const add = (rule: string, where: string, message: string) =>
    problems.push({ rule, where, message });
  const done = (record: EvidenceRecord | null): Verified => ({
    file,
    ok: problems.length === 0,
    problems,
    record,
  });

  // 1. schema
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    add('schema', '/', 'a record must be a JSON object');
    return done(null);
  }
  for (const p of ctx.schemas.validate(ENVELOPE_ID, raw)) add('schema', p.path, p.message);
  const rec = raw as Partial<EvidenceRecord>;
  const trackKnown =
    typeof rec.track === 'string' && (TRACKS as readonly string[]).includes(rec.track);
  if (trackKnown) {
    for (const p of ctx.schemas.validate(trackSchemaId(rec.track as string), rec.details ?? null))
      add('schema', `/details${p.path === '/' ? '' : p.path}`, p.message);
  }
  if (problems.some((p) => p.rule === 'schema' && p.where === '/')) return done(null);
  const r = raw as EvidenceRecord;

  // 2. hashes
  if (typeof r.contentHash === 'string') {
    const want = computeContentHash(raw as Record<string, unknown>);
    if (want !== r.contentHash)
      add(
        'content-hash',
        '/contentHash',
        'does not equal the sha256 of the record (the record was edited after sealing)',
      );
  }
  const read = ctx.readFile ?? DEFAULT_READ;
  for (const [i, o] of (Array.isArray(r.outputs) ? r.outputs : []).entries()) {
    if (typeof o?.path !== 'string') continue;
    if (ctx.dir === null) {
      add('file-hash', `/outputs/${i}/path`, 'a path cannot be checked for an in-memory record');
      continue;
    }
    const abs = resolve(ctx.dir, o.path);
    if (abs !== ctx.dir && !abs.startsWith(ctx.dir + sep)) {
      add('file-hash', `/outputs/${i}/path`, 'the path leaves the record directory');
      continue;
    }
    const buf = read(abs);
    if (buf === null) add('file-hash', `/outputs/${i}/path`, `file not found: ${o.path}`);
    else {
      if (sha256Hex(buf) !== o.sha256)
        add(
          'file-hash',
          `/outputs/${i}/sha256`,
          `the recomputed hash of ${o.path} differs from the recorded one`,
        );
      if (typeof o.bytes === 'number' && o.bytes !== buf.length)
        add(
          'file-hash',
          `/outputs/${i}/bytes`,
          `the size of ${o.path} differs from the recorded one`,
        );
    }
  }

  // 3. label consistency
  const tokens = labelTokens(raw);
  if (tokens.simulated.length > 0 && tokens.live.length > 0)
    add(
      'mixed-labels',
      '/',
      `SIMULATED and LIVE-VERIFIED appear in one record (${tokens.simulated[0]} with ${tokens.live[0]})`,
    );
  if (r.label === 'LIVE-VERIFIED' && tokens.simulated.length > 0)
    add(
      'mixed-labels',
      '/label',
      `a LIVE-VERIFIED record contains a simulated marker (${tokens.simulated[0]})`,
    );
  if ((r.label === 'SIMULATED' || r.label === 'NOT VERIFIED') && tokens.live.length > 0)
    add(
      'mixed-labels',
      '/label',
      `a ${r.label} record contains a LIVE-VERIFIED marker (${tokens.live[0]})`,
    );
  for (const [i, c] of (Array.isArray(r.components) ? r.components : []).entries()) {
    if (r.label === 'LIVE-VERIFIED') {
      if (c.origin !== 'real')
        add(
          'mixed-labels',
          `/components/${i}/origin`,
          `a LIVE-VERIFIED record has a ${c.origin} component (${c.name})`,
        );
      if (c.label !== 'LIVE-VERIFIED')
        add(
          'mixed-labels',
          `/components/${i}/label`,
          `component ${c.name} is labelled ${c.label}, not LIVE-VERIFIED`,
        );
    }
    if (r.label === 'SIMULATED' && c.label === 'LIVE-VERIFIED')
      add(
        'mixed-labels',
        `/components/${i}/label`,
        `a SIMULATED record claims component ${c.name} is LIVE-VERIFIED`,
      );
  }
  for (const [i, c] of (Array.isArray(r.checks) ? r.checks : []).entries()) {
    if (r.label === 'LIVE-VERIFIED' && c.label !== 'LIVE-VERIFIED')
      add(
        'mixed-labels',
        `/checks/${i}/label`,
        `check ${c.id} is labelled ${c.label}, not LIVE-VERIFIED`,
      );
    if (r.label === 'SIMULATED' && c.label === 'LIVE-VERIFIED')
      add(
        'mixed-labels',
        `/checks/${i}/label`,
        `a SIMULATED record claims check ${c.id} is LIVE-VERIFIED`,
      );
  }

  // 4. live requirements
  if (r.label === 'LIVE-VERIFIED') {
    if (r.result !== 'PASS')
      add(
        'live',
        '/result',
        'a LIVE-VERIFIED record must have result PASS (a failed or blocked real run is recorded as NOT VERIFIED or FAIL with its blockers)',
      );
    if (!Array.isArray(r.approvals) || r.approvals.length === 0)
      add(
        'live',
        '/approvals',
        'a LIVE-VERIFIED record must name the recorded approvals that allowed it',
      );
    const idn = r.identity ?? {};
    const kinds = ['model', 'node', 'host', 'device'].filter(
      (k) => idn[k] && Object.keys(idn[k] as object).length > 0,
    );
    if (kinds.length === 0)
      add(
        'live',
        '/identity',
        'a LIVE-VERIFIED record must name the real model, node, host or device that ran it',
      );
    for (const k of kinds)
      for (const [f, v] of Object.entries(idn[k] as Record<string, string>))
        if (FAKE_IDENTITY.test(String(v)))
          add('live', `/identity/${k}/${f}`, `the identity looks like a stand-in ("${String(v)}")`);
    for (const [i, c] of (Array.isArray(r.components) ? r.components : []).entries())
      if (FAKE_IDENTITY.test(c.name) || FAKE_IDENTITY.test(c.version))
        add('live', `/components/${i}`, `component "${c.name}" looks like a stand-in`);
    if ((r.checks ?? []).length === 0)
      add('live', '/checks', 'a LIVE-VERIFIED record must carry its checks');
    for (const [i, c] of (r.checks ?? []).entries())
      if (c.result !== 'PASS') add('live', `/checks/${i}/result`, `check ${c.id} is ${c.result}`);
    if ((r.blockers ?? []).length > 0)
      add('live', '/blockers', 'a LIVE-VERIFIED record carries no blockers');
    if ((r.outputs ?? []).length === 0)
      add('live', '/outputs', 'a LIVE-VERIFIED record must carry the hash of at least one output');
    if (typeof r.durationMs !== 'number' || r.durationMs <= 0)
      add('live', '/durationMs', 'a real run has a positive duration');
    if (r.startedAt && r.finishedAt && Date.parse(r.finishedAt) <= Date.parse(r.startedAt))
      add('live', '/finishedAt', 'finishedAt must be after startedAt');
    if (
      r.cost &&
      /^\d+$/.test(r.cost.usedMinor) &&
      /^\d+$/.test(r.cost.maxMinor) &&
      BigInt(r.cost.usedMinor) > BigInt(r.cost.maxMinor)
    )
      add('live', '/cost', 'the cost used exceeds the hard maximum');
  }
  // 5. non-PASS records explain themselves; placement
  if (r.result !== 'PASS' && (r.blockers ?? []).length === 0 && r.label !== 'SIMULATED')
    add('blockers', '/blockers', 'a record that is not PASS must name its blockers or failures');
  if (r.label === 'NOT VERIFIED' && r.result === 'PASS')
    add('label', '/result', 'NOT VERIFIED cannot have result PASS');
  if (
    r.cost &&
    /^\d+$/.test(r.cost.usedMinor) &&
    /^\d+$/.test(r.cost.maxMinor) &&
    BigInt(r.cost.usedMinor) > BigInt(r.cost.maxMinor)
  )
    add('cost', '/cost', 'usedMinor exceeds maxMinor');
  if (ctx.placement) {
    const { trackDir, fileName } = ctx.placement;
    if (r.track !== trackDir)
      add('placement', '/track', `the record is under ${trackDir}/ but says track ${r.track}`);
    const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.json$/.exec(fileName);
    if (!m) add('placement', '/', `the file name must be <YYYY-MM-DD>-<id>.json, got ${fileName}`);
    else {
      if (m[2] !== r.id)
        add('placement', '/id', `the file name says id ${m[2]}, the record says ${r.id}`);
      if (typeof r.recordedAt === 'string' && !r.recordedAt.startsWith(m[1]!))
        add(
          'placement',
          '/recordedAt',
          `the file name says ${m[1]}, recordedAt is ${r.recordedAt}`,
        );
    }
  }

  // 6. secrets and personal data
  const text = JSON.stringify(raw);
  for (const f of scanForSecrets(text))
    add('secret', '/', `the secret scanner found a ${f.kind} (value not shown)`);
  for (const m of text.matchAll(EMAIL))
    if (!RESERVED_MAIL.test(m[1]!))
      add(
        'personal-data',
        '/',
        'an e-mail address that is not a reserved example one (evidence holds no personal data)',
      );
  return done(r);
}

/* ───────────────────────── directory verification ───────────────────────── */
export interface VerifyAll {
  results: Verified[];
  accepted: EvidenceRecord[];
  rejected: Verified[];
  problems: Problem[];
}
export function listEvidenceFiles(
  root = repoRoot(),
): { trackDir: string; fileName: string; abs: string }[] {
  const base = evidenceDir(root);
  const out: { trackDir: string; fileName: string; abs: string }[] = [];
  for (const d of readdirSync(base).sort()) {
    const dir = join(base, d);
    if (!statSync(dir).isDirectory() || d === 'schemas' || d.startsWith('_')) continue;
    for (const f of readdirSync(dir).sort())
      if (f.endsWith('.json')) out.push({ trackDir: d, fileName: f, abs: join(dir, f) });
  }
  return out;
}
export function verifyAll(root = repoRoot()): VerifyAll {
  const schemas = loadSchemas(root);
  const results: Verified[] = [];
  for (const f of listEvidenceFiles(root)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(f.abs, 'utf8'));
    } catch {
      results.push({
        file: `${f.trackDir}/${f.fileName}`,
        ok: false,
        record: null,
        problems: [{ rule: 'schema', where: '/', message: 'not valid JSON' }],
      });
      continue;
    }
    results.push(
      verifyRecord(
        raw,
        { schemas, dir: dirname(f.abs), placement: { trackDir: f.trackDir, fileName: f.fileName } },
        `${f.trackDir}/${f.fileName}`,
      ),
    );
  }
  const problems: Problem[] = [];
  const seen = new Map<string, string>();
  for (const v of results) {
    if (!v.record) continue;
    const prior = seen.get(v.record.id);
    if (prior) {
      v.ok = false;
      v.problems.push({
        rule: 'duplicate-id',
        where: '/id',
        message: `id ${v.record.id} is also used by ${prior}`,
      });
    } else seen.set(v.record.id, v.file);
  }
  return {
    results,
    accepted: results.filter((v) => v.ok && v.record).map((v) => v.record!),
    rejected: results.filter((v) => !v.ok),
    problems,
  };
}
