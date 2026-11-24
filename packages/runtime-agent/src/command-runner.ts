import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * THE ONLY DOOR TO A PROCESS. Every command the agent ever issues (`runsc`, `ip`, `nft`, `xfs_quota`) goes through a `CommandRunner` as an argv ARRAY (never a shell string), and the
 * runner decides whether it may run at all:
 *
 *  - `NodeCommandRunner`  starts real processes, but only after `NodeCommandRunner.create` proved the host is a Linux machine whose identity file names THIS node
 *                         (`/etc/nuzm/node.json`, written by the reviewed bootstrap script), only for binaries on a fixed absolute-path allow-list, with a scrubbed environment, and
 *                         never through a shell. On macOS (or anywhere that is not that node) `create` refuses, and so does every later call.
 *  - `RecordingCommandRunner`  records the argv and returns a scripted result; it starts NOTHING. Every test of the agent uses it, so a test cannot execute anything on the
 *                         machine it runs on.
 *  - `RefusedCommandRunner`  refuses everything (the default when no node proof exists).
 *
 * This is how R5 is enforced structurally: no code path in the agent can execute a workload on a machine that is not the attested node.
 */
export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** stdin text, if any */
  input?: string;
}
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** resolves when the process has exited and its output pipes are closed */
  wait(): Promise<{ code: number | null; signal: string | null }>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export interface SpawnOpts {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}
export interface CommandRunner {
  readonly kind: 'node' | 'recording' | 'refused';
  run(argv: readonly string[], opts?: RunOptions): Promise<CommandResult>;
  spawn(argv: readonly string[], opts: SpawnOpts): SpawnedProcess;
}

export class CommandRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommandRefused';
  }
}

export class RefusedCommandRunner implements CommandRunner {
  readonly kind = 'refused' as const;
  constructor(private readonly why = 'no_node_proof') {}
  async run(): Promise<never> {
    throw new CommandRefused(this.why);
  }
  spawn(): never {
    throw new CommandRefused(this.why);
  }
}

/** records every argv it is given and starts nothing */
export class RecordingCommandRunner implements CommandRunner {
  readonly kind = 'recording' as const;
  readonly calls: { argv: string[]; spawned: boolean }[] = [];
  private readonly spawned: {
    argv: string[];
    emit: (o: 'out' | 'err', s: string) => void;
    exit: (code: number | null, signal?: string | null) => void;
  }[] = [];
  /** scripted answers: the first matcher whose predicate matches the argv decides the result (default: exit 0, no output) */
  private readonly script: {
    match: (argv: readonly string[]) => boolean;
    result: Partial<CommandResult>;
  }[] = [];
  on(match: (argv: readonly string[]) => boolean, result: Partial<CommandResult>): this {
    this.script.push({ match, result });
    return this;
  }
  async run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], spawned: false });
    const hit = this.script.find((s) => s.match(argv));
    return { code: 0, signal: null, stdout: '', stderr: '', truncated: false, ...hit?.result };
  }
  spawn(argv: readonly string[], opts: SpawnOpts): SpawnedProcess {
    this.calls.push({ argv: [...argv], spawned: true });
    let resolve!: (v: { code: number | null; signal: string | null }) => void;
    const done = new Promise<{ code: number | null; signal: string | null }>((r) => {
      resolve = r;
    });
    let finished = false;
    const rec = {
      argv: [...argv],
      emit: (o: 'out' | 'err', s: string) =>
        (o === 'out' ? opts.onStdout : opts.onStderr)(Buffer.from(s)),
      exit: (code: number | null, signal: string | null = null) => {
        if (finished) return;
        finished = true;
        resolve({ code, signal });
      },
    };
    this.spawned.push(rec);
    return {
      pid: 1,
      wait: () => done,
      kill: (sig) => rec.exit(null, sig),
    };
  }
  /** test control: what the Nth spawned process prints and how it ends */
  spawnedProcess(n = this.spawned.length - 1) {
    const s = this.spawned[n];
    if (!s) throw new Error('no such spawned process');
    return s;
  }
  argvs(): string[][] {
    return this.calls.map((c) => c.argv);
  }
}

/** binaries the agent may start, by absolute path. Anything else is refused whatever the caller asks. */
export interface BinaryAllowList {
  runsc: string;
  ip: string;
  nft: string;
  xfsQuota: string;
}
export const DEFAULT_BINARIES: BinaryAllowList = {
  runsc: '/usr/local/bin/runsc',
  ip: '/usr/sbin/ip',
  nft: '/usr/sbin/nft',
  xfsQuota: '/usr/sbin/xfs_quota',
};
export interface NodeProof {
  /** `process.platform` (injectable only so the refusal can be tested) */
  platform: string;
  nodeId: string;
  /** path of the identity file written by the bootstrap script */
  identityFile?: string;
  readFile?: (path: string) => Promise<string>;
}
/** the exact environment a started command gets: no inherited variables (no cloud credentials, no proxy settings, no LD_*) */
const SCRUBBED_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
};

export class NodeCommandRunner implements CommandRunner {
  readonly kind = 'node' as const;
  private readonly allowed: Set<string>;
  private constructor(
    binaries: BinaryAllowList,
    private readonly platform: string,
    private readonly spawnImpl: typeof nodeSpawn,
  ) {
    this.allowed = new Set(Object.values(binaries));
  }
  /**
   * Proves the host is the attested node before a runner exists: Linux, and `/etc/nuzm/node.json` names this node id. Throws `CommandRefused` otherwise. `spawnImpl` exists so a
   * test can prove the guard and the allow-list without starting anything; production code never passes it.
   */
  static async create(
    proof: NodeProof,
    binaries: BinaryAllowList = DEFAULT_BINARIES,
    spawnImpl: typeof nodeSpawn = nodeSpawn,
  ): Promise<NodeCommandRunner> {
    if (proof.platform !== 'linux') throw new CommandRefused('not_linux');
    const read = proof.readFile ?? ((p: string) => readFile(p, 'utf8'));
    let ident: unknown;
    try {
      ident = JSON.parse(await read(proof.identityFile ?? '/etc/nuzm/node.json'));
    } catch {
      throw new CommandRefused('node_identity_file_missing');
    }
    const o = ident as { nodeId?: unknown; runtimeClass?: unknown };
    if (typeof o !== 'object' || o === null || o.nodeId !== proof.nodeId)
      throw new CommandRefused('node_identity_mismatch');
    if (o.runtimeClass !== 'gvisor-runsc') throw new CommandRefused('node_runtime_class_mismatch');
    return new NodeCommandRunner(binaries, proof.platform, spawnImpl);
  }
  private check(argv: readonly string[]): void {
    if (this.platform !== 'linux') throw new CommandRefused('not_linux');
    const bin = argv[0];
    if (bin === undefined || !this.allowed.has(bin)) throw new CommandRefused('binary_not_allowed');
    if (argv.some((a) => typeof a !== 'string' || a.includes('\0')))
      throw new CommandRefused('argv_invalid');
  }
  async run(argv: readonly string[], opts: RunOptions = {}): Promise<CommandResult> {
    this.check(argv);
    const cap = opts.maxOutputBytes ?? 1024 * 1024;
    return new Promise<CommandResult>((resolve, reject) => {
      const o: SpawnOptions = {
        shell: false,
        env: { ...SCRUBBED_ENV },
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      const child = this.spawnImpl(argv[0]!, argv.slice(1), o);
      let out = '';
      let err = '';
      let truncated = false;
      const take = (cur: string, c: Buffer) => {
        if (Buffer.byteLength(cur) + c.length > cap) {
          truncated = true;
          return cur;
        }
        return cur + c.toString('utf8');
      };
      child.stdout?.on('data', (c: Buffer) => (out = take(out, c)));
      child.stderr?.on('data', (c: Buffer) => (err = take(err, c)));
      const t = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
      child.on('error', (e) => {
        if (t) clearTimeout(t);
        reject(e);
      });
      child.on('close', (code, signal) => {
        if (t) clearTimeout(t);
        resolve({ code, signal, stdout: out, stderr: err, truncated });
      });
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  }
  spawn(argv: readonly string[], opts: SpawnOpts): SpawnedProcess {
    this.check(argv);
    const child = this.spawnImpl(argv[0]!, argv.slice(1), {
      shell: false,
      env: { ...SCRUBBED_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    child.stdout?.on('data', (c: Buffer) => opts.onStdout(c));
    child.stderr?.on('data', (c: Buffer) => opts.onStderr(c));
    const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('error', () => resolve({ code: null, signal: 'SPAWN_ERROR' }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    return { pid: child.pid, wait: () => done, kill: (s) => void child.kill(s) };
  }
}
