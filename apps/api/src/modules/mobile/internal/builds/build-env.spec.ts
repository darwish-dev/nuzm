import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectApk, listZipEntries } from './apk-evidence';
import {
  assessBuildEnvironment,
  requireDisposableEnvironment,
  type EnvProbe,
} from './build-env-guard';
import { BuildEnvFailure, DisposableAndroidRunner } from './disposable-runner';
import { BuildFailure, LocalAndroidRunner, type BuildInput, type BuildOutput } from './runner';
import { makeBuildRunner } from '../../mobile.module';

const good = (over: Partial<EnvProbe> = {}, env: NodeJS.ProcessEnv = {}): EnvProbe => ({
  env: {
    PATH: '/usr/bin',
    NUZM_BUILD_ENV: 'disposable',
    NUZM_BUILD_ISOLATION: 'container',
    NUZM_BUILD_USER: 'builder',
    NUZM_REGISTRY_MIRROR: 'http://mirror.internal:8081',
    ...env,
  },
  user: 'builder',
  home: '/home/builder',
  platform: 'linux',
  exists: () => false,
  ...over,
});

describe('disposable build environment guard', () => {
  it('accepts a declared container environment and reports what it cannot verify', () => {
    const a = assessBuildEnvironment(good());
    expect(a.ok).toBe(true);
    expect(a.isolation).toBe('container');
    expect(a.reasons).toEqual([]);
  });
  it('refuses a normal shell: nothing declared', () => {
    const a = assessBuildEnvironment({
      env: { PATH: '/usr/bin' },
      user: 'elaf',
      home: '/Users/elaf',
      platform: 'darwin',
      exists: () => false,
    });
    expect(a.ok).toBe(false);
    expect(a.reasons.join()).toMatch(/NUZM_BUILD_ENV/);
    expect(a.isolation).toBeNull();
    expect(() =>
      requireDisposableEnvironment({
        env: {},
        user: 'x',
        home: '/h',
        platform: 'linux',
        exists: () => false,
      }),
    ).toThrow(/build refused/);
  });
  it('refuses when the declared build user is not the current user, or is the owner account', () => {
    expect(assessBuildEnvironment(good({ user: 'someone-else' })).reasons.join()).toMatch(
      /not the current user/,
    );
    expect(assessBuildEnvironment(good({}, { NUZM_OWNER_USER: 'builder' })).reasons.join()).toMatch(
      /owner account/,
    );
  });
  it('a dedicated user must be named nuzm-build*; it is never reported as container/vm isolation', () => {
    const bad = assessBuildEnvironment(
      good(
        { user: 'elaf', platform: 'darwin' },
        { NUZM_BUILD_ISOLATION: 'dedicated-user', NUZM_BUILD_USER: 'elaf' },
      ),
    );
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join()).toMatch(/nuzm-build/);
    const ok = assessBuildEnvironment(
      good(
        { user: 'nuzm-build', platform: 'darwin' },
        { NUZM_BUILD_ISOLATION: 'dedicated-user', NUZM_BUILD_USER: 'nuzm-build' },
      ),
    );
    expect(ok.ok).toBe(true);
    expect(ok.warnings.join()).toMatch(/NOT VERIFIED/);
  });
  it('refuses any secret-looking environment variable, by name only (the value is never read into the reasons)', () => {
    const a = assessBuildEnvironment(
      good(
        {},
        {
          DATABASE_URL: 'postgres://u:p@h/db',
          GITHUB_TOKEN: 'x',
          AWS_ACCESS_KEY_ID: 'y',
          SSH_AUTH_SOCK: '/tmp/agent',
        },
      ),
    );
    expect(a.ok).toBe(false);
    const msg = a.reasons.join();
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/GITHUB_TOKEN/);
    expect(msg).toMatch(/SSH_AUTH_SOCK/);
    expect(msg).not.toContain('postgres://');
  });
  it('refuses a home that holds personal or credential locations', () => {
    const a = assessBuildEnvironment(
      good({ exists: (p) => p === '/home/builder/.ssh' || p === '/home/builder/.aws' }),
    );
    expect(a.ok).toBe(false);
    expect(a.reasons.join()).toMatch(/\.ssh/);
  });
  it('ordinary build variables are fine', () => {
    expect(
      assessBuildEnvironment(
        good(
          {},
          {
            JAVA_HOME: '/opt/jdk',
            ANDROID_HOME: '/opt/android',
            PUB_HOSTED_URL: 'http://m/pub',
            FLUTTER_ROOT: '/opt/flutter',
            GRADLE_USER_HOME: '/home/builder/.gradle',
          },
        ),
      ).ok,
    ).toBe(true);
  });
});

/** a minimal STORED zip builder so the structural check is tested on real zip bytes, not mocks */
function zip(names: string[], opts: { sigBlock?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n);
    const data = Buffer.from('x');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const sig = opts.sigBlock
    ? Buffer.concat([Buffer.alloc(8), Buffer.from('APK Sig Block 42', 'latin1')])
    : Buffer.alloc(0);
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset + sig.length, 16);
  return Buffer.concat([...locals, sig, cd, eocd]);
}
const GOOD_APK = [
  'AndroidManifest.xml',
  'classes.dex',
  'resources.arsc',
  'lib/arm64-v8a/libflutter.so',
  'lib/arm64-v8a/libapp.so',
  'lib/x86_64/libflutter.so',
  'assets/flutter_assets/AssetManifest.bin',
];

describe('APK evidence', () => {
  it('lists zip entries from the central directory', () => {
    expect(listZipEntries(zip(['a', 'b/c'])).names).toEqual(['a', 'b/c']);
  });
  it('hashes and inspects a structurally valid APK', () => {
    const b = zip(GOOD_APK, { sigBlock: true });
    const e = inspectApk(b);
    expect(e.sha256).toBe(createHash('sha256').update(b).digest('hex'));
    expect(e).toMatchObject({
      bytes: b.length,
      hasManifest: true,
      hasDex: true,
      hasFlutterEngine: true,
      hasFlutterAssets: true,
      signatureScheme: 'v2+',
      abis: ['arm64-v8a', 'x86_64'],
      structuralIssues: [],
    });
  });
  it('flags a missing manifest or dex, v1-only and unsigned', () => {
    expect(inspectApk(zip(['classes.dex'])).structuralIssues).toContain(
      'AndroidManifest.xml is missing',
    );
    expect(inspectApk(zip(['AndroidManifest.xml'])).structuralIssues).toContain('no classes.dex');
    expect(
      inspectApk(zip([...GOOD_APK, 'META-INF/CERT.SF', 'META-INF/CERT.RSA'])).signatureScheme,
    ).toBe('v1');
    expect(inspectApk(zip(GOOD_APK)).signatureScheme).toBe('none');
  });
  it('rejects non-zip bytes (a mock artifact is never an APK)', () => {
    expect(inspectApk(Buffer.from('MOCK-NOT-A-REAL-APK:abc')).structuralIssues[0]).toMatch(
      /not a zip/,
    );
  });
});

describe('DisposableAndroidRunner', () => {
  const input: BuildInput = {
    buildId: '00000000-0000-7000-8000-000000000009',
    platform: 'android',
    profile: 'debug',
    files: {},
    verifyLock: async () => undefined,
  };
  const fakeInner = (bytes: Buffer, calls: string[]): LocalAndroidRunner =>
    ({
      run: async (): Promise<BuildOutput> => {
        calls.push('inner.run');
        return {
          artifacts: [{ kind: 'apk', fileName: 'app-debug.apk', bytes }],
          toolchain: { runner: 'local-android', flutter: '3.35.7' },
          signed: false,
        };
      },
    }) as unknown as LocalAndroidRunner;

  it('refuses BEFORE the build starts when the environment is not a declared disposable one', async () => {
    const calls: string[] = [];
    const r = new DisposableAndroidRunner({
      probe: {
        env: { PATH: '/usr/bin' },
        user: 'elaf',
        home: '/Users/elaf',
        platform: 'darwin',
        exists: () => false,
      },
      inner: fakeInner(Buffer.alloc(0), calls),
    });
    expect(r.supports('android', 'debug')).toBe(false);
    const lines: string[] = [];
    await expect(r.run(input, (l) => lines.push(l))).rejects.toMatchObject({
      code: 'build_env_refused',
    });
    expect(calls).toEqual([]); // the pipeline never ran
    await expect(r.run(input, () => undefined)).rejects.toBeInstanceOf(BuildEnvFailure);
    expect(lines.join('\n')).toMatch(/not a disposable build environment/);
  });
  it('inside a declared container: runs, records apk evidence and the container label, and is never signed with a production key', async () => {
    const calls: string[] = [];
    const bytes = zip(GOOD_APK, { sigBlock: true });
    const r = new DisposableAndroidRunner({
      probe: good(),
      inner: fakeInner(bytes, calls),
      toolchainProbe: async () => ({ java: 'openjdk version "17"' }),
    });
    expect(r.supports('android', 'debug')).toBe(true);
    expect(r.supports('android', 'release')).toBe(false);
    expect(r.supports('ios', 'debug')).toBe(false);
    const out = await r.run(input, () => undefined);
    expect(calls).toEqual(['inner.run']);
    expect(out.signed).toBe(false);
    expect(r.isolation).toBe('container');
    expect(out.toolchain).toMatchObject({
      runner: 'disposable-android',
      isolation: 'container',
      java: 'openjdk version "17"',
      apk: { sha256: createHash('sha256').update(bytes).digest('hex'), signatureScheme: 'v2+' },
    });
    expect(String(out.toolchain.signing)).toMatch(/not a release signature/);
  });
  it('a dedicated user is recorded as isolation none, never as container/vm', async () => {
    const probe = good(
      { user: 'nuzm-build', platform: 'darwin' },
      { NUZM_BUILD_ISOLATION: 'dedicated-user', NUZM_BUILD_USER: 'nuzm-build' },
    );
    const r = new DisposableAndroidRunner({
      probe,
      inner: fakeInner(zip(GOOD_APK), []),
      toolchainProbe: async () => ({}),
    });
    const out = await r.run(input, () => undefined);
    expect(r.isolation).toBe('none');
    expect(out.toolchain.isolation).toBe('none');
  });
  it('a structurally invalid artifact fails the build (a mock APK can never pass)', async () => {
    const r = new DisposableAndroidRunner({
      probe: good(),
      inner: fakeInner(Buffer.from('MOCK-NOT-A-REAL-APK:1'), []),
      toolchainProbe: async () => ({}),
    });
    await expect(r.run(input, () => undefined)).rejects.toMatchObject({
      code: 'apk_structure_invalid',
    });
  });
  it('the module wires the runner only by explicit selection, and never in production', () => {
    expect(
      makeBuildRunner({ MOBILE_BUILD_RUNNER: 'disposable-android' } as NodeJS.ProcessEnv).kind,
    ).toBe('disposable-android');
    expect(
      makeBuildRunner({
        MOBILE_BUILD_RUNNER: 'disposable-android',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv).kind,
    ).toBe('unavailable');
    expect(makeBuildRunner({} as NodeJS.ProcessEnv).kind).toBe('unavailable');
    expect(new BuildFailure('x', 'y').parsed).toBeUndefined();
  });
});
