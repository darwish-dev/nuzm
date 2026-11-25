import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Db } from '@nuzm/platform';
import { executionGateway as eg, isUuid } from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { newPreviewToken, type LivePreviewRegistry } from '../../../builder';
import { flagOn } from '../flag.guard';
import { generateProject } from '../gen/project';
import type { AppSpecService } from '../spec/spec.service';

export const LIVE_PREVIEW_FLAG = 'app_builder.live_preview';
export interface LivePreviewConfig {
  ttlMs: number;
  perOrg: number;
  total: number;
  startTimeoutMs: number;
  /** where previews are written; inside apps/api so the runtime's `pg` import resolves from its node_modules */
  workRoot: string;
  launcher: string;
}
export const DEFAULT_LIVE_PREVIEW: LivePreviewConfig = {
  ttlMs: 30 * 60_000,
  perOrg: 2,
  total: 8,
  startTimeoutMs: 20_000,
  workRoot: join(__dirname, '../../../../../.gen-tmp'),
  launcher: join(__dirname, '../../../../../templates/webapp-preview/preview-launch.ts'),
};
export interface LivePreviewDto {
  url: string;
  expiresAt: string;
  specVersion: number;
}

/**
 * Live preview of a generated web application (ADR-063, flag `app_builder.live_preview`, default off, refused in production until a sandbox exists — HG pending).
 * The newest spec is rendered by the trusted generator (model-authored code from the changes pipeline is NOT run), written to a private folder, and started as a CHILD
 * process with an empty environment (no platform secret, no database, no vault) and an in-memory store. The child listens on loopback only; the browser reaches it through
 * the isolated preview origin `<token>.<previewDomain>`. One preview per project; a few per organization; each stops itself after the TTL.
 */
export class WebappLivePreviewService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly specs: AppSpecService,
    private readonly registry: LivePreviewRegistry,
    private readonly cfg: LivePreviewConfig = DEFAULT_LIVE_PREVIEW,
  ) {}

  async start(orgId: string, userId: string, projectId: string): Promise<LivePreviewDto> {
    if (process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'unsupported_capability',
        'live previews need an isolated sandbox, which is not set up in this environment',
      );
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    if (!(await flagOn(this.db, orgId, LIVE_PREVIEW_FLAG)))
      throw new ProblemException('feature_disabled', 'live preview is not enabled');
    const spec = await this.specs.get(orgId, projectId); // newest version; not_found when nothing was built
    this.registry.stopProject(orgId, projectId);
    if (this.registry.list(orgId).length >= this.cfg.perOrg)
      throw new ProblemException(
        'rate_limited',
        'too many previews are running for this organization',
      );
    if (this.registry.list().length >= this.cfg.total)
      throw new ProblemException('service_unavailable', 'previews are busy; try again shortly');

    // R5: the preview runs on the API host (not isolated). What runs is the output of OUR deterministic generator (`generateProject`), so the origin is minted here, server-side; the
    // guard still needs NODE_ENV != production and the explicit opt-in env, and is audited.
    eg.assertHostExecAllowed('live-preview', eg.templateOrigin('webapp-preview'));
    const project = generateProject(spec.spec);
    mkdirSync(this.cfg.workRoot, { recursive: true });
    this.sweepStale();
    const dir = mkdtempSync(join(this.cfg.workRoot, 'preview-'));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      for (const [path, content] of project.files) {
        if (!(path.startsWith('src/') || path.startsWith('public/'))) continue; // the runtime and its front end; nothing else is needed to run it
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      // the front end of a preview sends its session in a header the preview origin lets through, and signs in from the address it is opened with
      const meta = JSON.parse(project.files.get('public/meta.json') ?? '{}') as Record<
        string,
        unknown
      >;
      writeFileSync(
        join(dir, 'public/meta.json'),
        JSON.stringify({ ...meta, preview: true, authHeader: 'x-preview-authorization' }),
      );
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
      copyFileSync(this.cfg.launcher, join(dir, 'preview-launch.ts'));
    } catch (e) {
      cleanup();
      throw e;
    }

    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'preview-launch.ts'],
      {
        cwd: dir,
        // nothing of the platform's environment: no secrets, no database address
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'development',
          PREVIEW_TTL_MS: String(this.cfg.ttlMs),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stop = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      cleanup();
    };
    child.on('exit', cleanup);
    let ready: { port: number; session: string };
    try {
      ready = await this.ready(child);
    } catch (e) {
      stop();
      throw e;
    }
    const token = newPreviewToken();
    const expiresAt = Date.now() + this.cfg.ttlMs;
    this.registry.register(token, { orgId, projectId, port: ready.port, expiresAt, stop });
    await this.audit.record({
      action: 'builder.webapp_preview.started',
      orgId,
      actorUserId: userId,
      resource: { type: 'builder_project', id: projectId },
      outcome: 'success',
      detail: { specVersion: spec.version, ttlMinutes: Math.round(this.cfg.ttlMs / 60_000) },
    });
    return {
      url: this.registry.url(token, ready.session),
      expiresAt: new Date(expiresAt).toISOString(),
      specVersion: spec.version,
    };
  }

  /** Folders left by previews whose API process died (the child exits with it, but cannot remove its own folder): anything older than a preview's lifetime. */
  private sweepStale() {
    const cutoff = Date.now() - this.cfg.ttlMs - 60_000;
    for (const name of readdirSync(this.cfg.workRoot)) {
      if (!name.startsWith('preview-')) continue;
      const full = join(this.cfg.workRoot, name);
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  }

  stop(orgId: string, projectId: string): void {
    this.registry.stopProject(orgId, projectId);
  }

  private ready(child: ChildProcess): Promise<{ port: number; session: string }> {
    return new Promise((resolve, reject) => {
      let err = '';
      child.stderr?.on('data', (b: Buffer) => {
        if (err.length < 4000) err += b.toString();
      });
      const timer = setTimeout(
        () =>
          reject(new ProblemException('service_unavailable', 'the preview did not start in time')),
        this.cfg.startTimeoutMs,
      );
      const rl = createInterface({ input: child.stdout! });
      rl.once('line', (line) => {
        clearTimeout(timer);
        try {
          const v = JSON.parse(line) as { port?: unknown; session?: unknown };
          if (typeof v.port === 'number' && typeof v.session === 'string')
            return resolve({ port: v.port, session: v.session });
        } catch {
          /* fall through */
        }
        reject(new ProblemException('service_unavailable', 'the preview did not start'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        // the child's error output stays in the server log, never in the response
        if (err)
          console.error(
            JSON.stringify({ livePreview: 'exited', code, stderr: err.slice(0, 2000) }),
          );
        reject(new ProblemException('service_unavailable', 'the preview stopped while starting'));
      });
    });
  }
}
