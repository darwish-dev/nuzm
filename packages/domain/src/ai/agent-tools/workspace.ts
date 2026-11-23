import { isAgentSensitivePath } from './paths';

/**
 * The project as a tool sees it: a READ-ONLY, in-memory snapshot of one project's text files (D-46, SCR-K-10 §3). There is no handle to a filesystem, a process or a network
 * behind it; a tool can only ask this object. Who wrote a file matters for exactly one rule (rule 5 of the AI Intelligence plan): a file that is still the TEMPLATE's (unchanged
 * since the copy) may be given to a model only when the template's AI-processing permission allows it; the customer's own work always may.
 */
export type FileOrigin = 'template' | 'customer';
export interface WorkspaceEntry {
  path: string;
  bytes: number;
  origin: FileOrigin;
}
export type Access =
  | { ok: true; text: string; origin: FileOrigin }
  | { ok: false; code: 'not_found' | 'sensitive_path' | 'ai_processing_not_allowed' };

export class ReadOnlyWorkspace {
  private readonly files: ReadonlyMap<string, string>;
  private readonly origins: ReadonlyMap<string, FileOrigin>;
  private readonly sorted: WorkspaceEntry[];
  /** `aiProcessing`: the template's permission; unknown means not allowed */
  readonly aiProcessing: boolean;

  constructor(
    files: ReadonlyMap<string, string>,
    opts: { origins?: ReadonlyMap<string, FileOrigin>; aiProcessing: boolean },
  ) {
    this.files = new Map(files);
    this.origins = new Map(opts.origins ?? []);
    this.aiProcessing = opts.aiProcessing === true;
    this.sorted = [...this.files.entries()]
      .map(([path, text]) => ({
        path,
        bytes: Buffer.byteLength(text, 'utf8'),
        origin: this.originOf(path),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private originOf(path: string): FileOrigin {
    return this.origins.get(path) ?? 'customer';
  }
  get size(): number {
    return this.files.size;
  }
  /** Every path the model may KNOW about: sensitive paths are not part of the view at all. */
  entries(): readonly WorkspaceEntry[] {
    return this.sorted.filter((e) => !isAgentSensitivePath(e.path));
  }
  /** Whether the content of an entry may be given to a model. */
  readable(e: WorkspaceEntry): boolean {
    return e.origin === 'customer' || this.aiProcessing;
  }
  access(path: string): Access {
    if (isAgentSensitivePath(path)) return { ok: false, code: 'sensitive_path' };
    const text = this.files.get(path);
    if (text === undefined) return { ok: false, code: 'not_found' };
    const origin = this.originOf(path);
    if (origin === 'template' && !this.aiProcessing)
      return { ok: false, code: 'ai_processing_not_allowed' };
    return { ok: true, text, origin };
  }
  has(path: string): boolean {
    return this.files.has(path) && !isAgentSensitivePath(path);
  }
}
