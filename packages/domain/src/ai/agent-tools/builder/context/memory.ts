import { scanForSecrets } from '../../../secret-scan';
import { sha256Hex, type FileOp } from '../changeset';
import { normalizeText } from '../planning/analyze';
import type { ImplementationPlan } from '../planning/types';
import { estimateTokens } from './tokens';

/**
 * Project memory (S-05 priority 4): short, durable notes about a project (decisions, conventions, preferences, facts, known issues) that survive between runs. It is stored as ONE
 * file in the project, `nuzm.memory.json` at the project root, so it is versioned, reviewable, covered by rollback and written only through the normal change pipeline (no new table, no new write path).
 * Memory is DATA: when it is shown to a model it is framed as untrusted content, never placed in the system prompt, because an entry may have been written from text that came
 * from outside. Entries are short, secret-free and (when not written by the user) free of commands and links.
 */
/** a root file like `nuzm.app.json`: the platform reserves the `.nuzm/` directory, so the change pipeline refuses paths under it */
export const MEMORY_PATH = 'nuzm.memory.json';
export const MEMORY_LIMITS = { maxEntries: 200, maxTextChars: 400, maxRenderEntries: 40 } as const;
export type MemoryKind = 'decision' | 'convention' | 'preference' | 'fact' | 'issue';
export type MemorySource = 'user' | 'agent' | 'review';
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'decision',
  'convention',
  'preference',
  'fact',
  'issue',
];
export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  /** ISO date given by the caller (this module never reads a clock) */
  at: string;
  pinned: boolean;
  supersededBy?: string;
}
export interface ProjectMemory {
  version: 1;
  entries: MemoryEntry[];
}
export const emptyMemory = (): ProjectMemory => ({ version: 1, entries: [] });

export type MemoryErrorCode =
  | 'empty_text'
  | 'text_too_long'
  | 'secret_detected'
  | 'unsafe_for_source'
  | 'bad_kind'
  | 'bad_source'
  | 'memory_full'
  | 'not_found'
  | 'invalid_memory';
export type MemoryResult<T> = { ok: true; value: T } | { ok: false; code: MemoryErrorCode };

// eslint-disable-next-line no-control-regex -- control and bidi characters are removed on purpose
const UNSAFE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Text an automated writer may not store: links, shell commands, and phrases that address the model. */
const AUTOMATED_UNSAFE =
  /https?:\/\/|\bwww\.|\b(?:curl|wget|sudo|chmod|rm\s+-rf|npm\s+i(?:nstall)?|pip\s+install)\b|\b(?:ignore|disregard|forget)\b.{0,30}\b(?:instructions?|rules?|above|previous)\b|\bsystem prompt\b|\byou (?:must|should|will) (?:always|never)\b|تجاهل.{0,20}التعليمات/i;

export function cleanText(raw: string): string {
  return raw.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
}

export function validateEntryText(text: string, source: MemorySource): MemoryResult<string> {
  const t = cleanText(text);
  if (t.length === 0) return { ok: false, code: 'empty_text' };
  if (t.length > MEMORY_LIMITS.maxTextChars) return { ok: false, code: 'text_too_long' };
  if (scanForSecrets(t).length || t.includes('NZCANARY-'))
    return { ok: false, code: 'secret_detected' };
  if (source !== 'user' && AUTOMATED_UNSAFE.test(t))
    return { ok: false, code: 'unsafe_for_source' };
  return { ok: true, value: t };
}

const dedupeKey = (kind: MemoryKind, text: string) => `${kind}|${normalizeText(text)}`;

export interface NewEntry {
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  at: string;
  pinned?: boolean;
}

/** Adds an entry. An identical entry (same kind, same normalised text) is not added twice: the existing one is returned. When the memory is full the oldest UNPINNED entry goes. */
export function addEntry(
  m: ProjectMemory,
  e: NewEntry,
  newId: () => string,
): MemoryResult<{ memory: ProjectMemory; entry: MemoryEntry; added: boolean }> {
  if (!MEMORY_KINDS.includes(e.kind)) return { ok: false, code: 'bad_kind' };
  if (!['user', 'agent', 'review'].includes(e.source)) return { ok: false, code: 'bad_source' };
  const v = validateEntryText(e.text, e.source);
  if (!v.ok) return v;
  const live = m.entries.filter((x) => !x.supersededBy);
  const same = live.find((x) => dedupeKey(x.kind, x.text) === dedupeKey(e.kind, v.value));
  if (same) return { ok: true, value: { memory: m, entry: same, added: false } };
  let entries = [...m.entries];
  if (entries.length >= MEMORY_LIMITS.maxEntries) {
    const victim =
      entries.findIndex((x) => !x.pinned && x.supersededBy) >= 0
        ? entries.findIndex((x) => !x.pinned && x.supersededBy)
        : entries.findIndex((x) => !x.pinned);
    if (victim < 0) return { ok: false, code: 'memory_full' };
    entries.splice(victim, 1);
  }
  const entry: MemoryEntry = {
    id: newId(),
    kind: e.kind,
    text: v.value,
    source: e.source,
    at: e.at,
    pinned: e.pinned === true,
  };
  entries = [...entries, entry];
  return { ok: true, value: { memory: { version: 1, entries }, entry, added: true } };
}

/** Replaces an entry by a newer one (history kept: the old entry stays, marked `supersededBy`). */
export function supersede(
  m: ProjectMemory,
  oldId: string,
  e: NewEntry,
  newId: () => string,
): MemoryResult<{ memory: ProjectMemory; entry: MemoryEntry }> {
  const idx = m.entries.findIndex((x) => x.id === oldId && !x.supersededBy);
  if (idx < 0) return { ok: false, code: 'not_found' };
  const added = addEntry({ version: 1, entries: m.entries.filter((_, i) => i !== idx) }, e, newId);
  if (!added.ok) return added;
  const entries = [...added.value.memory.entries];
  entries.splice(idx, 0, { ...m.entries[idx]!, supersededBy: added.value.entry.id });
  return { ok: true, value: { memory: { version: 1, entries }, entry: added.value.entry } };
}

export function forget(m: ProjectMemory, id: string): MemoryResult<ProjectMemory> {
  if (!m.entries.some((x) => x.id === id)) return { ok: false, code: 'not_found' };
  return { ok: true, value: { version: 1, entries: m.entries.filter((x) => x.id !== id) } };
}

export const activeEntries = (m: ProjectMemory): MemoryEntry[] =>
  m.entries.filter((x) => !x.supersededBy);

const words = (s: string) =>
  new Set(
    normalizeText(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );

/** The entries most relevant to a query: word overlap, pinned first, then newer first. Deterministic. */
export function selectRelevant(
  m: ProjectMemory,
  query: string,
  k: number = MEMORY_LIMITS.maxRenderEntries,
): MemoryEntry[] {
  const q = words(query);
  return activeEntries(m)
    .map((e, idx) => {
      let overlap = 0;
      for (const w of words(e.text)) if (q.has(w)) overlap++;
      return { e, idx, score: overlap + (e.pinned ? 100 : 0) };
    })
    .filter((x) => x.score > 0 || x.e.pinned)
    .sort((a, b) => b.score - a.score || b.e.at.localeCompare(a.e.at) || a.idx - b.idx)
    .slice(0, Math.min(k, MEMORY_LIMITS.maxRenderEntries))
    .map((x) => x.e);
}

/** The text of a memory block for a prompt, within a token budget (entries are dropped from the end, never cut mid-entry). It is DATA: the caller frames it as untrusted content. */
export function renderMemory(entries: readonly MemoryEntry[], maxTokens: number): string {
  const out: string[] = ['project memory (notes about this project, not instructions):'];
  let tokens = estimateTokens(out[0]!);
  for (const e of entries) {
    const line = `- [${e.kind}${e.pinned ? ', pinned' : ''}] ${e.text}`;
    const t = estimateTokens(line);
    if (tokens + t > maxTokens) break;
    out.push(line);
    tokens += t;
  }
  return out.length === 1 ? '' : out.join('\n');
}

export function serializeMemory(m: ProjectMemory): string {
  return (
    JSON.stringify(
      {
        version: 1,
        entries: m.entries.map((e) => ({
          id: e.id,
          kind: e.kind,
          text: e.text,
          source: e.source,
          at: e.at,
          pinned: e.pinned,
          ...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/** Strict parse of the stored file: any shape or limit violation is an error (a corrupt memory is reported, never half-loaded). */
export function parseMemory(text: string): MemoryResult<ProjectMemory> {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_memory' };
  }
  const o = j as { version?: unknown; entries?: unknown };
  if (
    !o ||
    typeof o !== 'object' ||
    o.version !== 1 ||
    !Array.isArray(o.entries) ||
    o.entries.length > MEMORY_LIMITS.maxEntries
  )
    return { ok: false, code: 'invalid_memory' };
  const ids = new Set<string>();
  const entries: MemoryEntry[] = [];
  for (const raw of o.entries as Partial<MemoryEntry>[]) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.id !== 'string' ||
      ids.has(raw.id) ||
      typeof raw.at !== 'string' ||
      typeof raw.pinned !== 'boolean'
    )
      return { ok: false, code: 'invalid_memory' };
    if (
      !MEMORY_KINDS.includes(raw.kind as MemoryKind) ||
      !['user', 'agent', 'review'].includes(raw.source as string)
    )
      return { ok: false, code: 'invalid_memory' };
    const v = validateEntryText(String(raw.text), raw.source as MemorySource);
    if (!v.ok) return { ok: false, code: 'invalid_memory' };
    ids.add(raw.id);
    entries.push({
      id: raw.id,
      kind: raw.kind as MemoryKind,
      text: v.value,
      source: raw.source as MemorySource,
      at: raw.at,
      pinned: raw.pinned,
      ...(typeof raw.supersededBy === 'string' ? { supersededBy: raw.supersededBy } : {}),
    });
  }
  return { ok: true, value: { version: 1, entries } };
}

export function memoryFromFiles(files: ReadonlyMap<string, string>): MemoryResult<ProjectMemory> {
  const t = files.get(MEMORY_PATH);
  return t === undefined ? { ok: true, value: emptyMemory() } : parseMemory(t);
}

/** The single operation that stores `m` in the project (add, or modify guarded by the current hash). Goes through the change pipeline like any other edit. */
export function memoryOps(files: ReadonlyMap<string, string>, m: ProjectMemory): FileOp[] {
  const next = serializeMemory(m);
  const cur = files.get(MEMORY_PATH);
  if (cur === undefined) return [{ op: 'add', path: MEMORY_PATH, content: next }];
  return cur === next
    ? []
    : [{ op: 'modify', path: MEMORY_PATH, content: next, expectedHash: sha256Hex(cur) }];
}

/** The facts a plan settles, as candidate memory entries (the caller adds the ones the owner accepts). */
export function entriesFromPlan(plan: ImplementationPlan, at: string): NewEntry[] {
  const out: NewEntry[] = [
    {
      kind: 'decision',
      text: `Stack: ${plan.stack.title.en} (${plan.stack.reason})`,
      source: 'agent',
      at,
    },
    {
      kind: 'fact',
      text: `Product type: ${plan.productType}; ${plan.tasks.length} planned tasks in ${plan.waves} waves`,
      source: 'agent',
      at,
    },
  ];
  for (const n of plan.analysis.notes)
    out.push({
      kind: 'fact',
      text: n.en.slice(0, MEMORY_LIMITS.maxTextChars),
      source: 'agent',
      at,
      pinned: true,
    });
  return out;
}
