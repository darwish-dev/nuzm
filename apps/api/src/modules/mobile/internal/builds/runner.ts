import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PINNED_TOOLCHAIN } from '../flutter/toolchain';
import {
  applyAndroidSdkConfig,
  checkPlatformFiles,
  validatePlatformSettings,
  type PlatformSettings,
} from '../flutter/platform-config';
import { failureFromStage, type BuildStage, type ParseResult } from './errors';

export type Platform = 'android' | 'ios';
export type Profile = 'debug' | 'release';
export interface BuildInput {
  buildId: string;
  platform: Platform;
  profile: Profile;
  files: Record<string, string>;
  /** called with the text of pubspec.lock once resolved, BEFORE anything is compiled; throws to stop the build (supply-chain gate) */
  verifyLock(lockText: string): Promise<void>;
  signal?: AbortSignal;
}
export interface BuildOutput {
  artifacts: { kind: 'apk' | 'aab' | 'ipa' | 'symbols'; fileName: string; bytes: Buffer }[];
  toolchain: Record<string, unknown>;
  /** true only if the artifact was signed by the signing stage; the local runner never signs */
  signed: boolean;
}
export class BuildFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** structured errors parsed from the failing stage's output, for the repair loop (P3-S03); absent for failures that have no tool output */
    readonly parsed?: ParseResult,
    readonly stage?: BuildStage,
  ) {
    super(message);
  }
}

/**
 * A build worker (S49). `isolation` says how the build was isolated: the LOCAL runner is `none` (a child process on the API host): it is a development aid and NEVER isolation evidence.
 * Android builds in "sandbox-class isolation" need the D-21 runtime (BLOCKED); iOS needs macOS capacity (D-22 / HG-10-01: BLOCKED, never simulated).
 */
export abstract class BuildRunnerPort {
  abstract readonly kind: string;
  abstract readonly isolation: 'none' | 'container' | 'vm';
  /** a runner that can run THIS platform/profile (false = 503 at request time, never a fake success) */
  abstract supports(platform: Platform, profile: Profile): boolean;
  abstract run(input: BuildInput, log: (line: string) => void): Promise<BuildOutput>;
}

/** Nothing can run: production default until D-21 / D-22 / HG-10-01. */
export class UnavailableBuildRunner extends BuildRunnerPort {
  readonly kind = 'unavailable';
  readonly isolation = 'none' as const;
  supports(): boolean {
    return false;
  }
  async run(): Promise<never> {
    throw new BuildFailure('build_runner_unavailable', 'no build worker is available');
  }
}

/** Test/dev double: returns deterministic bytes that are obviously not an APK. Labelled `mock` in the toolchain record; never evidence of a build. */
export class MockBuildRunner extends BuildRunnerPort {
  readonly kind = 'mock';
  readonly isolation = 'none' as const;
  constructor(private readonly opts: { fail?: string; android?: boolean; ios?: boolean } = {}) {
    super();
  }
  supports(platform: Platform, profile: Profile): boolean {
    return (
      profile === 'debug' &&
      (platform === 'android' ? this.opts.android !== false : this.opts.ios === true)
    );
  }
  async run(i: BuildInput, log: (l: string) => void): Promise<BuildOutput> {
    log(`mock build ${i.buildId} (${i.platform}/${i.profile}): not a real build`);
    await i.verifyLock(
      'packages:\n  http:\n    dependency: "direct main"\n    description:\n      name: http\n      url: "https://pub.dev"\n    source: hosted\n    version: "1.5.0"\n',
    );
    if (this.opts.fail) throw new BuildFailure(this.opts.fail, `mock failure ${this.opts.fail}`);
    return {
      artifacts: [
        {
          kind: 'apk',
          fileName: 'app-debug.apk',
          bytes: Buffer.from(`MOCK-NOT-A-REAL-APK:${i.buildId}`),
        },
      ],
      toolchain: { mock: true, runner: 'mock', flutter: PINNED_TOOLCHAIN.flutter },
      signed: false,
    };
  }
}

/** The only environment variables a build process receives: no database URL, no platform secret, no token, ever. */
const ENV_ALLOW = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'FLUTTER_ROOT',
  'PUB_CACHE',
  'PUB_HOSTED_URL',
  'FLUTTER_STORAGE_BASE_URL',
  'GRADLE_USER_HOME',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];
export const buildEnv = (src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {
    CI: 'true',
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
    CLI_DISABLE_ANALYTICS: '1',
  };
  for (const k of ENV_ALLOW) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

interface Run {
  code: number | null;
  timedOut: boolean;
  out: string;
}
function exec(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: (l: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const feed = (b: Buffer) => {
      const t = b.toString('utf8');
      if (out.length < 400_000) out += t;
      for (const l of t.split('\n')) if (l.trim()) log(l);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, timedOut: false, out: String(e.message) });
    });
  });
}

/** Add `<uses-permission>` entries for the declared permissions to the main manifest (idempotent). Declared in `tool/nuzm-mobile.json`, nothing else is ever added. */
export const ANDROID_PERMISSION: Record<string, string> = {
  internet: 'android.permission.INTERNET',
  camera: 'android.permission.CAMERA',
  location: 'android.permission.ACCESS_FINE_LOCATION',
  notifications: 'android.permission.POST_NOTIFICATIONS',
  photos: 'android.permission.READ_MEDIA_IMAGES',
};
export function applyAndroidPermissions(manifestXml: string, permissions: string[]): string {
  const wanted = permissions
    .map((p) => ANDROID_PERMISSION[p])
    .filter((x): x is string => Boolean(x));
  let xml = manifestXml;
  for (const name of wanted) {
    if (xml.includes(`android:name="${name}"`)) continue;
    xml = xml.replace(
      /<manifest([^>]*)>/,
      (m) => `${m}\n    <uses-permission android:name="${name}"/>`,
    );
  }
  return xml;
}

/**
 * Local Android DEBUG build with the host's Flutter/Android toolchain (dev aid). It is UNSIGNED and NOT ISOLATED (`isolation: 'none'`); it refuses a Flutter version other than the
 * pinned one, runs only a closed list of commands with a minimal environment, resolves pubspec.lock and hands it to the supply-chain gate BEFORE compiling, and times out
 * (20 minutes). Enabled only by `MOBILE_BUILD_RUNNER=local-android` (never in production).
 */
export class LocalAndroidRunner extends BuildRunnerPort {
  readonly kind = 'local-android';
  readonly isolation = 'none' as const;
  constructor(
    private readonly o: {
      flutter?: string;
      timeoutMs?: number;
      workRoot?: string;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    super();
  }
  supports(platform: Platform, profile: Profile): boolean {
    return platform === 'android' && profile === 'debug';
  }
  async run(i: BuildInput, log: (l: string) => void): Promise<BuildOutput> {
    const flutter = this.o.flutter ?? 'flutter';
    const timeout = this.o.timeoutMs ?? 20 * 60_000;
    const env = buildEnv(this.o.env);
    const root = await mkdtemp(
      join(this.o.workRoot ?? tmpdir(), `nuzm-mobile-${i.buildId.slice(0, 8)}-`),
    );
    const started = Date.now();
    try {
      const step = async (
        args: string[],
        what: string,
        ms = timeout - (Date.now() - started),
        stage?: BuildStage,
      ) => {
        log(`$ flutter ${args.join(' ')}`);
        const r = await exec(flutter, args, root, env, log, Math.max(1000, ms), i.signal);
        if (r.timedOut) throw new BuildFailure('build_timeout', `${what} timed out`);
        if (r.code !== 0)
          throw new BuildFailure(
            `${what.replace(/\s+/g, '_')}_failed`,
            `${what} failed (exit ${String(r.code)})`,
            failureFromStage(r.out, r.code, { ...(stage ? { stage } : {}), roots: [root] }),
            stage,
          );
        return r.out;
      };
      // 1. toolchain: exactly the pinned Flutter
      const v = await exec(
        flutter,
        ['--version', '--machine'],
        root,
        env,
        () => undefined,
        60_000,
        i.signal,
      );
      let version = '';
      try {
        version =
          (JSON.parse(v.out.slice(v.out.indexOf('{'))) as { frameworkVersion?: string })
            .frameworkVersion ?? '';
      } catch {
        /* handled below */
      }
      if (version !== PINNED_TOOLCHAIN.flutter)
        throw new BuildFailure(
          'toolchain_mismatch',
          `Flutter ${version || 'unknown'} is not the pinned ${PINNED_TOOLCHAIN.flutter}`,
        );
      // 2. sources
      for (const [p, text] of Object.entries(i.files)) {
        const dst = join(root, p);
        if (!dst.startsWith(root + '/'))
          throw new BuildFailure('unsafe_path', 'a file path leaves the project');
        await mkdir(dirname(dst), { recursive: true });
        await writeFile(dst, text);
      }
      const manifest = JSON.parse(i.files['tool/nuzm-mobile.json'] ?? '{}') as {
        applicationId?: string;
        packageName?: string;
        permissions?: string[];
      } & PlatformSettings;
      const settingIssues = validatePlatformSettings(manifest as Record<string, unknown>);
      if (settingIssues.length)
        throw new BuildFailure(
          'manifest_invalid',
          `tool/nuzm-mobile.json: ${settingIssues.join('; ')}`,
        );
      if (!manifest.applicationId || !manifest.packageName)
        throw new BuildFailure(
          'manifest_missing',
          'tool/nuzm-mobile.json is missing or incomplete',
        );
      const org = manifest.applicationId.split('.').slice(0, -1).join('.');
      // 3. platform folder from the pinned toolchain, declared permissions, dependency resolution
      await step(
        [
          'create',
          '--platforms=android',
          '--org',
          org,
          '--project-name',
          manifest.packageName,
          '.',
        ],
        'flutter create',
      );
      const mf = join(root, 'android/app/src/main/AndroidManifest.xml');
      await writeFile(
        mf,
        applyAndroidPermissions(await readFile(mf, 'utf8'), manifest.permissions ?? ['internet']),
      );
      if (manifest.android) {
        const gradlePath = join(root, 'android/app/build.gradle.kts');
        const alt = join(root, 'android/app/build.gradle');
        const gp = await readFile(gradlePath, 'utf8')
          .then(() => gradlePath)
          .catch(() => alt);
        try {
          await writeFile(gp, applyAndroidSdkConfig(await readFile(gp, 'utf8'), manifest.android));
        } catch (e) {
          throw new BuildFailure('platform_config_failed', String((e as Error).message));
        }
      }
      // cleartext traffic and undeclared permissions in the created platform files stop the build before anything is compiled
      const platformIssues = checkPlatformFiles(
        {
          androidManifests: Object.fromEntries(
            await Promise.all(
              ['main', 'debug'].map(async (v) => {
                const f = `android/app/src/${v}/AndroidManifest.xml`;
                return [f, await readFile(join(root, f), 'utf8').catch(() => '')] as const;
              }),
            ),
          ),
        },
        manifest.permissions ?? ['internet'],
      );
      if (platformIssues.length)
        throw new BuildFailure(
          'platform_policy_violation',
          platformIssues.map((x) => `${x.rule}: ${x.file}: ${x.detail}`).join('; '),
        );
      await step(['pub', 'get'], 'pub get', undefined, 'pub_get');
      // 4. the supply-chain gate sees the resolved lockfile before anything is compiled
      const lock = await readFile(join(root, 'pubspec.lock'), 'utf8').catch(() => '');
      await i.verifyLock(lock);
      // 5. the checks the template promises, then the debug build
      await step(['analyze'], 'flutter analyze', undefined, 'analyze');
      await step(['test'], 'flutter test', undefined, 'test');
      await step(['build', 'apk', '--debug'], 'flutter build apk', undefined, 'build_apk');
      const dir = join(root, 'build/app/outputs/flutter-apk');
      const apk = (await readdir(dir).catch(() => [] as string[])).find(
        (f) => f === 'app-debug.apk',
      );
      if (!apk) throw new BuildFailure('artifact_missing', 'the build produced no app-debug.apk');
      return {
        artifacts: [{ kind: 'apk', fileName: apk, bytes: await readFile(join(dir, apk)) }],
        toolchain: {
          runner: this.kind,
          isolation: this.isolation,
          flutter: version,
          dart: PINNED_TOOLCHAIN.dart,
          templateSet: PINNED_TOOLCHAIN.templateSet,
          pubHostedUrl: env.PUB_HOSTED_URL ?? 'https://pub.dev',
          signed: false,
        },
        signed: false,
      };
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
