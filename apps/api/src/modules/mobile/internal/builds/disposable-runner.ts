import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inspectApk } from './apk-evidence';
import {
  assessBuildEnvironment,
  BuildEnvRefused,
  defaultProbe,
  type EnvAssessment,
  type EnvProbe,
} from './build-env-guard';
import {
  BuildFailure,
  BuildRunnerPort,
  LocalAndroidRunner,
  buildEnv,
  type BuildInput,
  type BuildOutput,
  type Platform,
  type Profile,
} from './runner';

const sh = promisify(execFile);

/** A refusal is a BuildFailure so the build service records `build_env_refused` and the (value-free) reasons, never a generic error. */
export class BuildEnvFailure extends BuildFailure {
  constructor(readonly assessment: EnvAssessment) {
    super('build_env_refused', new BuildEnvRefused(assessment).message);
  }
}

/**
 * Android debug build inside a DISPOSABLE build environment (P3-S06, B-Android). Same pipeline as the local runner (`flutter create` with the pinned toolchain, declared permissions and
 * bounded SDK settings, `pub get`, the supply-chain gate on `pubspec.lock`, `flutter analyze`, `flutter test`, `flutter build apk --debug`), plus:
 *  - the environment guard runs FIRST: a process that is not inside a declared disposable environment (see `build-env-guard.ts`) is refused before any file is written;
 *  - the toolchain actually used (Flutter, Dart, JDK, installed Android platforms/build-tools) is recorded;
 *  - APK evidence: SHA-256, size and structural inspection (`apk-evidence.ts`); install/launch and `apkanalyzer` come from `infra/mobile/android/verify-apk.sh`;
 *  - signing: only the debug/test key that the Android Gradle plugin creates in the throwaway build home; never a production key, never a store key (`signed` stays false).
 * Labelled `isolation: container|vm` ONLY when the declared environment is a container/VM; a dedicated user on the owner's machine is recorded as `none`.
 *
 * NOT VERIFIED end to end: no disposable environment has been approved or created yet (B-Android); the guard, the pipeline wiring and the evidence code are unit-tested, the build
 * itself is exercised by `flutter-local.int.spec.ts` (MOBILE_FLUTTER_LOCAL=1) in the quiet window.
 */
export class DisposableAndroidRunner extends BuildRunnerPort {
  readonly kind = 'disposable-android';
  private assessed: EnvAssessment;
  constructor(
    private readonly o: {
      probe?: EnvProbe;
      inner?: LocalAndroidRunner;
      /** gather toolchain versions; replaced in tests */
      toolchainProbe?: (env: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;
    } = {},
  ) {
    super();
    this.assessed = assessBuildEnvironment(o.probe ?? defaultProbe());
  }
  /** 'container' / 'vm' only when the declared environment is one and the guard passed; everything else is 'none' (never presented as isolation evidence) */
  get isolation(): 'none' | 'container' | 'vm' {
    return this.assessed.ok &&
      (this.assessed.isolation === 'container' || this.assessed.isolation === 'vm')
      ? this.assessed.isolation
      : 'none';
  }
  /** a runner that cannot pass the guard does not claim to support any build (503 at request time instead of a failure after queueing) */
  supports(platform: Platform, profile: Profile): boolean {
    this.assessed = assessBuildEnvironment(this.o.probe ?? defaultProbe());
    return this.assessed.ok && platform === 'android' && profile === 'debug';
  }
  async run(i: BuildInput, log: (line: string) => void): Promise<BuildOutput> {
    const a = assessBuildEnvironment(this.o.probe ?? defaultProbe());
    this.assessed = a;
    if (!a.ok) {
      log('build refused: not a disposable build environment');
      for (const r of a.reasons) log(`refused: ${r}`);
      throw new BuildEnvFailure(a);
    }
    for (const w of a.warnings) log(`environment warning: ${w}`);
    const env = buildEnv((this.o.probe ?? defaultProbe()).env);
    const inner =
      this.o.inner ?? new LocalAndroidRunner({ env: (this.o.probe ?? defaultProbe()).env });
    const out = await inner.run(i, log);
    const apk = out.artifacts.find((x) => x.kind === 'apk');
    if (!apk) throw new BuildFailure('artifact_missing', 'the build produced no apk');
    const evidence = inspectApk(apk.bytes);
    if (evidence.structuralIssues.length)
      throw new BuildFailure(
        'apk_structure_invalid',
        `APK structure: ${evidence.structuralIssues.join('; ')}`,
      );
    log(
      `apk sha256=${evidence.sha256} bytes=${evidence.bytes} signature=${evidence.signatureScheme} abis=${evidence.abis.join(',')}`,
    );
    const probe = await (this.o.toolchainProbe ?? probeToolchain)(env);
    return {
      artifacts: out.artifacts,
      signed: false,
      toolchain: {
        ...out.toolchain,
        runner: this.kind,
        isolation: this.isolation,
        buildEnvironment: { declared: a.isolation, warnings: a.warnings },
        signing:
          'debug-test-key (Android Gradle plugin throwaway debug keystore in the build home); not a release signature',
        apk: evidence,
        ...probe,
      },
    };
  }
}

/** the versions of the tools the build really used. Read-only commands; output is never secret. */
export async function probeToolchain(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const run = async (cmd: string, args: string[]) => {
    try {
      const r = await sh(cmd, args, { env, timeout: 30_000 });
      return `${r.stdout}${r.stderr}`.trim();
    } catch (e) {
      return `unavailable: ${(e as Error).message.split('\n')[0]}`;
    }
  };
  out.java = (
    await run(env.JAVA_HOME ? join(env.JAVA_HOME, 'bin/java') : 'java', ['-version'])
  ).split('\n')[0];
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (sdk) {
    const ls = async (d: string) =>
      (await readdir(join(sdk, d)).catch(() => [] as string[])).sort();
    out.androidPlatforms = await ls('platforms');
    out.androidBuildTools = await ls('build-tools');
  }
  return out;
}
