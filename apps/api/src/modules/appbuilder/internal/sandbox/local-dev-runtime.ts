import { spawn } from 'node:child_process';
import { executionGateway as eg } from '@nuzm/domain';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkPath, MAX_FILE_BYTES } from './paths';
import { ConfinementError, confinedPath } from './confine';
import {
  MAX_OUTPUT_BYTES,
  RuntimeNoCapacity,
  RuntimeQuotaError,
  SandboxRuntime,
  type ExecRequest,
  type ExecResult,
  type RuntimeSpec,
  type RuntimeStats,
} from './runtime';

/** Commands the local dev runner may start (argv[0]). Anything else is refused. */
const ALLOWED = new Set(['node', 'npm', 'npx', 'tsc']);

/**
 * LOCAL DEVELOPMENT RUNNER: runs commands as child processes of the API process in a temporary directory, with a scrubbed environment (no platform secrets), no shell, a
 * wall-clock kill and an output cap. It is **NOT ISOLATED**: the process runs as the developer's user, can read the machine's files and use the network. It exists only so
 * the pipeline can be exercised locally; it is labelled `isolation: 'none'`, refuses to start unless SANDBOX_LOCAL_DEV=true outside production, and is never counted as
 * isolation evidence (AC-M10-02/03 need the real runner of D-21).
 */
export class LocalDevSandboxRuntime extends SandboxRuntime {
  readonly kind = 'local-dev' as const;
  readonly isolation = 'none' as const;
  private readonly dirs = new Map<string, string>();
  constructor(private readonly maxSandboxes = 4) {
    super();
    if (process.env.SANDBOX_LOCAL_DEV !== 'true' || process.env.NODE_ENV === 'production')
      throw new Error(
        'the local dev sandbox runner is disabled (set SANDBOX_LOCAL_DEV=true outside production; it is NOT isolated)',
      );
  }
  async freeSlots() {
    return Math.max(0, this.maxSandboxes - this.dirs.size);
  }
  async create(spec: RuntimeSpec): Promise<string> {
    // R5: this runner is NOT isolated. Beyond the dev switch it needs the opt-in env and a server-minted template-origin proof; model/customer code never runs here.
    eg.assertHostExecAllowed('local-dev-sandbox', spec?.origin);
    if ((await this.freeSlots()) <= 0) throw new RuntimeNoCapacity();
    const dir = mkdtempSync(join(tmpdir(), 'nuzm-sbx-'));
    const handle = 'local-' + randomBytes(8).toString('hex');
    this.dirs.set(handle, dir);
    return handle;
  }
  private dir(h: string): string {
    const d = this.dirs.get(h);
    if (!d) throw new Error('unknown sandbox handle');
    return d;
  }
  async writeFiles(handle: string, files: ReadonlyMap<string, string>) {
    const root = this.dir(handle);
    for (const [p, c] of files) {
      const err = checkPath(p);
      if (err) throw new RuntimeQuotaError('files', `${p}: ${err}`);
      if (Buffer.byteLength(c) > MAX_FILE_BYTES)
        throw new RuntimeQuotaError('disk', `${p} is too large`);
      let full: string;
      try {
        full = confinedPath(root, p, 'write');
      } catch (e) {
        if (e instanceof ConfinementError)
          throw new RuntimeQuotaError('files', `${p}: ${e.reason}`);
        throw e;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, c, { flag: 'w' });
    }
  }
  async readFiles(handle: string, paths?: string[]) {
    const root = this.dir(handle);
    const out = new Map<string, string>();
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isSymbolicLink()) continue; // a symlink is never followed out of the sandbox
        if (f.isDirectory()) {
          if (f.name !== 'node_modules' && f.name !== 'dist') walk(p);
        } else if (statSync(p).size <= MAX_FILE_BYTES)
          out.set(relative(root, p), readFileSync(p, 'utf8'));
      }
    };
    if (paths)
      for (const p of paths) {
        const err = checkPath(p);
        if (err) throw new RuntimeQuotaError('files', `${p}: ${err}`);
        let full: string;
        try {
          full = confinedPath(root, p, 'read');
        } catch (e) {
          if (e instanceof ConfinementError)
            throw new RuntimeQuotaError('files', `${p}: ${e.reason}`);
          throw e;
        }
        try {
          out.set(p, readFileSync(full, 'utf8'));
        } catch {
          /* missing file: not in the result */
        }
      }
    else walk(root);
    return out;
  }
  async exec(handle: string, req: ExecRequest): Promise<ExecResult> {
    const root = this.dir(handle);
    const argv0 = req.argv[0] ?? '';
    if (!ALLOWED.has(argv0))
      return {
        exitCode: 126,
        signal: null,
        stdout: '',
        stderr: `${argv0}: not allowed in the local dev runner\n`,
        durationMs: 0,
        timedOut: false,
        truncated: false,
        cpuSeconds: 0,
      };
    let cwd = root;
    if (req.cwd) {
      if (relative(root, join(root, req.cwd)).startsWith('..'))
        throw new RuntimeQuotaError('files', 'cwd escapes the sandbox');
      try {
        cwd = confinedPath(root, req.cwd, 'dir');
      } catch (e) {
        if (e instanceof ConfinementError) throw new RuntimeQuotaError('files', `cwd: ${e.reason}`);
        throw e;
      }
    }
    const started = Date.now();
    // scrubbed environment: only what the build needs; none of the platform's variables
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      TMPDIR: root,
      NODE_ENV: 'test',
      CI: 'true',
      ...(req.env ?? {}),
    };
    const cpu0 = process.cpuUsage();
    return new Promise<ExecResult>((resolve) => {
      const child = spawn(argv0, req.argv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let truncated = false;
      let timedOut = false;
      const cap = (s: string, add: string) => {
        if (s.length + add.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return (s + add).slice(0, MAX_OUTPUT_BYTES);
        }
        return s + add;
      };
      child.stdout.on('data', (d: Buffer) => (out = cap(out, d.toString('utf8'))));
      child.stderr.on('data', (d: Buffer) => (err = cap(err, d.toString('utf8'))));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, req.timeoutMs);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const u = process.cpuUsage(cpu0);
        resolve({
          exitCode: code,
          signal,
          stdout: out,
          stderr: err,
          durationMs: Date.now() - started,
          timedOut,
          truncated,
          cpuSeconds: (u.user + u.system) / 1e6,
        });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          exitCode: 127,
          signal: null,
          stdout: out,
          stderr: String(e.message),
          durationMs: Date.now() - started,
          timedOut: false,
          truncated,
          cpuSeconds: 0,
        });
      });
    });
  }
  async stats(handle: string): Promise<RuntimeStats> {
    this.dir(handle);
    return { cpuSeconds: 0, memoryMb: 0, diskMb: 0, pids: 0 };
  }
  async destroy(handle: string) {
    const d = this.dirs.get(handle);
    if (d) rmSync(d, { recursive: true, force: true });
    this.dirs.delete(handle);
  }
}
