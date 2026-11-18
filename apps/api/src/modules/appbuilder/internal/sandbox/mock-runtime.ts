import { randomBytes } from 'node:crypto';
import { checkPath, MAX_FILE_BYTES } from './paths';
import { RuntimeNoCapacity, RuntimeQuotaError, SandboxRuntime, type ExecRequest, type ExecResult, type RuntimeSpec, type RuntimeStats } from './runtime';

export type MockCommand = (ctx: { files: Map<string, string>; argv: string[]; env: Record<string, string>; sandbox: MockSandbox }) => Promise<Partial<ExecResult> & { cpuSeconds?: number }> | (Partial<ExecResult> & { cpuSeconds?: number });
export interface MockSandbox {
  id: string;
  spec: RuntimeSpec;
  files: Map<string, string>;
  cpuSeconds: number;
  pids: number;
  /** What the HOST puts in the environment: planted with canaries by the canary framework, and visible to no command unless the mock is told the attempt succeeded. */
  hostEnv: Record<string, string>;
}

/**
 * In-memory runtime: it starts NO process and isolates NOTHING. It enforces the quotas and the path checks the control plane owns, runs scripted commands (tests register
 * them) and lets the escape suite exercise those control-plane controls. `isolation = 'simulated'` is not evidence of isolation (see runtime.ts).
 */
export class MockSandboxRuntime extends SandboxRuntime {
  readonly kind = 'mock' as const;
  readonly isolation = 'simulated' as const;
  readonly sandboxes = new Map<string, MockSandbox>();
  private readonly commands = new Map<string, MockCommand>();
  constructor(private slots = 100) {
    super();
    this.register('echo', ({ argv }) => ({ stdout: argv.slice(1).join(' ') + '\n', exitCode: 0 }));
    this.register('cat', ({ argv, files }) => {
      const p = argv[1] ?? '';
      const err = checkPath(p);
      if (err) return { stderr: `cat: ${p}: ${err}\n`, exitCode: 1 };
      const c = files.get(p);
      return c === undefined ? { stderr: `cat: ${p}: No such file\n`, exitCode: 1 } : { stdout: c, exitCode: 0 };
    });
    this.register('true', () => ({ exitCode: 0 }));
    this.register('false', () => ({ exitCode: 1 }));
  }
  setSlots(n: number) {
    this.slots = n;
  }
  register(argv0: string, c: MockCommand) {
    this.commands.set(argv0, c);
  }
  private sb(handle: string): MockSandbox {
    const s = this.sandboxes.get(handle);
    if (!s) throw new Error('unknown sandbox handle');
    return s;
  }
  async freeSlots() {
    return Math.max(0, this.slots - this.sandboxes.size);
  }
  async create(spec: RuntimeSpec): Promise<string> {
    if ((await this.freeSlots()) <= 0) throw new RuntimeNoCapacity();
    const handle = 'mock-' + randomBytes(8).toString('hex');
    this.sandboxes.set(handle, { id: spec.sandboxId, spec, files: new Map(), cpuSeconds: 0, pids: 1, hostEnv: {} });
    return handle;
  }
  async writeFiles(handle: string, files: ReadonlyMap<string, string>) {
    const s = this.sb(handle);
    let bytes = [...s.files.values()].reduce((n, c) => n + Buffer.byteLength(c), 0);
    for (const [p, c] of files) {
      const err = checkPath(p);
      if (err) throw new RuntimeQuotaError('files', `${p}: ${err}`);
      const size = Buffer.byteLength(c);
      if (size > MAX_FILE_BYTES) throw new RuntimeQuotaError('disk', `${p} is larger than ${MAX_FILE_BYTES} bytes`);
      bytes += size - Buffer.byteLength(s.files.get(p) ?? '');
      if (bytes > s.spec.quota.diskGb * 1024 ** 3) throw new RuntimeQuotaError('disk', 'the disk quota is exhausted');
      if (s.files.size >= 50_000 && !s.files.has(p)) throw new RuntimeQuotaError('files', 'too many files');
      s.files.set(p, c);
    }
  }
  async readFiles(handle: string, paths?: string[]) {
    const s = this.sb(handle);
    const out = new Map<string, string>();
    for (const p of paths ?? [...s.files.keys()]) {
      const err = checkPath(p);
      if (err) throw new RuntimeQuotaError('files', `${p}: ${err}`);
      const c = s.files.get(p);
      if (c !== undefined) out.set(p, c);
    }
    return out;
  }
  async exec(handle: string, req: ExecRequest): Promise<ExecResult> {
    const s = this.sb(handle);
    const started = Date.now();
    const cmd = this.commands.get(req.argv[0] ?? '');
    if (!cmd) return { exitCode: 127, signal: null, stdout: '', stderr: `${req.argv[0]}: command not found\n`, durationMs: 0, timedOut: false, truncated: false, cpuSeconds: 0 };
    if (s.pids + 1 > s.spec.quota.pids) throw new RuntimeQuotaError('pids', 'the process quota is exhausted');
    const r = await cmd({ files: s.files, argv: req.argv, env: req.env ?? {}, sandbox: s });
    const cpu = r.cpuSeconds ?? 0.01;
    const timedOut = r.timedOut === true || cpu * 1000 > req.timeoutMs;
    s.cpuSeconds += Math.min(cpu, req.timeoutMs / 1000);
    return { exitCode: timedOut ? null : (r.exitCode ?? 0), signal: timedOut ? 'SIGKILL' : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', durationMs: Date.now() - started, timedOut, truncated: false, cpuSeconds: cpu };
  }
  async stats(handle: string): Promise<RuntimeStats> {
    const s = this.sb(handle);
    return { cpuSeconds: s.cpuSeconds, memoryMb: 0, diskMb: [...s.files.values()].reduce((n, c) => n + Buffer.byteLength(c), 0) / 1024 ** 2, pids: s.pids };
  }
  async destroy(handle: string) {
    this.sandboxes.delete(handle);
  }
}
