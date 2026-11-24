import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assessBuildEnvironment,
  defaultProbe,
  type EnvAssessment,
  type EnvProbe,
} from './build-env-guard';
import { BuildEnvFailure } from './disposable-runner';
import { failureFromStage, type BuildStage } from './errors';
import {
  BuildFailure,
  BuildRunnerPort,
  buildEnv,
  exec as realExec,
  type BuildInput,
  type BuildOutput,
  type Platform,
  type Profile,
  type Run,
} from './runner';
import { PINNED_TOOLCHAIN } from '../flutter/toolchain';
import {
  applyIosDeploymentTarget,
  applyIosPermissions,
  checkPlatformFiles,
  validatePlatformSettings,
  type PlatformSettings,
} from '../flutter/platform-config';

export type Exec = (
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: (l: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Run>;

/**
 * iOS build WITHOUT code signing on a macOS host with full Xcode (T4, B-iOS): `flutter build ios --no-codesign --simulator` and an independent `xcodebuild` simulator build with
 * `CODE_SIGNING_ALLOWED=NO`. No Apple credential, signing identity, provisioning profile or account is read or needed, and nothing is uploaded. Runs only in a declared build
 * environment (dedicated macOS user `nuzm-build`, see `docs/mobile/ios-build-host.md`); a dedicated user is recorded `isolation: none`.
 *
 * NOT VERIFIED: written against Flutter's and Xcode's documented command lines and tested with a FAKE executor only. No full Xcode exists on the owner's Mac yet, so this has never
 * run for real. The first real run must be treated as a test of this class. The produced `.app` is a simulator bundle: it is recorded (deterministic content hash) but never stored
 * as a distributable artifact (`artifacts` is empty).
 */
export class MacosIosRunner extends BuildRunnerPort {
  readonly kind = 'macos-ios';
  readonly isolation = 'none' as const;
  constructor(
    private readonly o: {
      probe?: EnvProbe;
      exec?: Exec;
      flutter?: string;
      timeoutMs?: number;
      workRoot?: string;
      platform?: NodeJS.Platform;
    } = {},
  ) {
    super();
  }
  private assess(): EnvAssessment {
    const a = assessBuildEnvironment(this.o.probe ?? defaultProbe());
    return a;
  }
  supports(platform: Platform, profile: Profile): boolean {
    return (
      (this.o.platform ?? process.platform) === 'darwin' &&
      this.assess().ok &&
      platform === 'ios' &&
      profile === 'debug'
    );
  }
  async run(i: BuildInput, log: (line: string) => void): Promise<BuildOutput> {
    const a = this.assess();
    if (!a.ok) {
      for (const r of a.reasons) log(`refused: ${r}`);
      throw new BuildEnvFailure(a);
    }
    if ((this.o.platform ?? process.platform) !== 'darwin')
      throw new BuildFailure('build_env_refused', 'iOS builds need macOS');
    const sh = this.o.exec ?? realExec;
    const flutter = this.o.flutter ?? 'flutter';
    const env = buildEnv((this.o.probe ?? defaultProbe()).env);
    const timeout = this.o.timeoutMs ?? 40 * 60_000;
    const root = await mkdtemp(
      join(this.o.workRoot ?? tmpdir(), `nuzm-ios-${i.buildId.slice(0, 8)}-`),
    );
    const started = Date.now();
    const left = () => Math.max(1000, timeout - (Date.now() - started));
    const stepAs = async (
      cmd: string,
      args: string[],
      what: string,
      stage: BuildStage,
    ): Promise<string> => {
      log(`$ ${cmd} ${args.join(' ')}`);
      const r = await sh(cmd, args, root, env, log, left(), i.signal);
      if (r.timedOut) throw new BuildFailure('build_timeout', `${what} timed out`);
      if (r.code !== 0)
        throw new BuildFailure(
          `${what.replace(/\s+/g, '_')}_failed`,
          `${what} failed (exit ${String(r.code)})`,
          failureFromStage(r.out, r.code, { stage, roots: [root] }),
          stage,
        );
      return r.out;
    };
    try {
      // 1. prerequisites: full Xcode must answer; the parser classifies a missing one as xcode_not_installed (environment: never "repaired")
      const xv = await sh('xcodebuild', ['-version'], root, env, () => undefined, 60_000, i.signal);
      if (xv.code !== 0 || !/^Xcode /m.test(xv.out))
        throw new BuildFailure(
          'xcode_not_installed',
          'full Xcode is not installed or not selected (B-iOS)',
          failureFromStage(xv.out, xv.code ?? 1, { stage: 'build_ios', roots: [root] }),
          'build_ios',
        );
      const xcode = xv.out
        .split('\n')
        .filter((l) => l.trim())
        .join(' ');
      // 2. toolchain: exactly the pinned Flutter
      const v = await sh(
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
      // 3. sources (path escape refused) and the declarative settings
      for (const [p, text] of Object.entries(i.files)) {
        const dst = join(root, p);
        if (!dst.startsWith(root + '/'))
          throw new BuildFailure('unsafe_path', 'a file path leaves the project');
        await mkdir(dirname(dst), { recursive: true });
        await writeFile(dst, text);
      }
      const m = JSON.parse(i.files['tool/nuzm-mobile.json'] ?? '{}') as {
        applicationId?: string;
        packageName?: string;
        permissions?: string[];
      } & PlatformSettings;
      const bad = validatePlatformSettings(m as Record<string, unknown>);
      if (bad.length)
        throw new BuildFailure('manifest_invalid', `tool/nuzm-mobile.json: ${bad.join('; ')}`);
      if (!m.applicationId || !m.packageName)
        throw new BuildFailure(
          'manifest_missing',
          'tool/nuzm-mobile.json is missing or incomplete',
        );
      const org = m.applicationId.split('.').slice(0, -1).join('.');
      await stepAs(
        flutter,
        ['create', '--platforms=ios', '--org', org, '--project-name', m.packageName, '.'],
        'flutter create',
        'build_ios',
      );
      const plistPath = join(root, 'ios/Runner/Info.plist');
      try {
        await writeFile(
          plistPath,
          applyIosPermissions(await readFile(plistPath, 'utf8'), m.permissions ?? ['internet']),
        );
      } catch (e) {
        throw new BuildFailure('platform_config_failed', String((e as Error).message));
      }
      const issues = checkPlatformFiles(
        { infoPlist: await readFile(plistPath, 'utf8') },
        m.permissions ?? ['internet'],
      );
      if (issues.length)
        throw new BuildFailure(
          'platform_policy_violation',
          issues.map((x) => `${x.rule}: ${x.file}: ${x.detail}`).join('; '),
        );
      // 4. dependencies, supply-chain gate on the resolved lockfile BEFORE anything compiles
      await stepAs(flutter, ['pub', 'get'], 'pub get', 'pub_get');
      await i.verifyLock(await readFile(join(root, 'pubspec.lock'), 'utf8').catch(() => ''));
      // `flutter create` does not write ios/Podfile (verified 2026-11-24 with Flutter 3.35.7); it appears once Flutter integrates plugins. The deployment-target override is applied only
      // to a Podfile that exists, and an explicit override with no Podfile is an error rather than a silent no-op.
      if (m.ios?.deploymentTarget !== undefined) {
        const podPath = join(root, 'ios/Podfile');
        try {
          await writeFile(
            podPath,
            applyIosDeploymentTarget(await readFile(podPath, 'utf8'), m.ios.deploymentTarget),
          );
        } catch (e) {
          throw new BuildFailure(
            'platform_config_failed',
            `ios.deploymentTarget could not be applied: ${(e as Error).message}`,
          );
        }
      }
      // 5. checks, then the two builds (never with signing)
      await stepAs(flutter, ['analyze'], 'flutter analyze', 'analyze');
      await stepAs(flutter, ['test'], 'flutter test', 'test');
      await stepAs(
        flutter,
        ['build', 'ios', '--no-codesign', '--simulator', '--debug'],
        'flutter build ios',
        'build_ios',
      );
      const app = join(root, 'build/ios/iphonesimulator/Runner.app');
      if (!(await stat(app).catch(() => null))?.isDirectory())
        throw new BuildFailure('artifact_missing', 'the build produced no Runner.app');
      await stepAs(
        'xcodebuild',
        [
          '-workspace',
          'ios/Runner.xcworkspace',
          '-scheme',
          'Runner',
          '-sdk',
          'iphonesimulator',
          '-configuration',
          'Debug',
          '-destination',
          'generic/platform=iOS Simulator',
          'CODE_SIGNING_ALLOWED=NO',
          'build',
        ],
        'xcodebuild',
        'xcodebuild',
      );
      const bundle = await hashTree(app);
      log(`Runner.app files=${bundle.files} sha256=${bundle.sha256}`);
      const sdk = (
        await sh(
          'xcrun',
          ['--sdk', 'iphonesimulator', '--show-sdk-version'],
          root,
          env,
          () => undefined,
          60_000,
          i.signal,
        )
      ).out.trim();
      return {
        artifacts: [],
        signed: false,
        toolchain: {
          runner: this.kind,
          isolation: this.isolation,
          flutter: version,
          dart: PINNED_TOOLCHAIN.dart,
          templateSet: PINNED_TOOLCHAIN.templateSet,
          xcode: xcode,
          iphonesimulatorSdk: sdk,
          codeSigning:
            'none (--no-codesign, CODE_SIGNING_ALLOWED=NO): no identity, profile or Apple account used',
          buildEnvironment: { declared: a.isolation, warnings: a.warnings },
          ios: {
            appBundleFiles: bundle.files,
            appBundleSha256: bundle.sha256,
            bundleKind: 'simulator .app (not distributable, not stored)',
          },
          signed: false,
        },
      };
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** deterministic content hash of a directory tree: sorted relative paths and file bytes (no timestamps, no permissions) */
export async function hashTree(dir: string): Promise<{ files: number; sha256: string }> {
  const h = createHash('sha256');
  let n = 0;
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) {
        h.update(`${r}\0`)
          .update(await readFile(p))
          .update('\0');
        n++;
      }
    }
  };
  await walk(dir, '');
  return { files: n, sha256: h.digest('hex') };
}
