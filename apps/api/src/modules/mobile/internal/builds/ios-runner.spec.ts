import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvProbe } from './build-env-guard';
import { MacosIosRunner, hashTree, type Exec } from './ios-runner';
import type { BuildInput } from './runner';
import { SAMPLE_MOBILE_SPEC } from '../fixtures/sample-spec';
import { generateFlutterProject } from '../flutter/templates';

const probe = (over: Partial<EnvProbe> = {}): EnvProbe => ({
  env: {
    PATH: '/usr/bin',
    NUZM_BUILD_ENV: 'disposable',
    NUZM_BUILD_ISOLATION: 'dedicated-user',
    NUZM_BUILD_USER: 'nuzm-build',
  },
  user: 'nuzm-build',
  home: '/Users/nuzm-build',
  platform: 'darwin',
  exists: () => false,
  ...over,
});
const input = (): BuildInput => ({
  buildId: '00000000-0000-7000-8000-00000000a106',
  platform: 'ios',
  profile: 'debug',
  files: generateFlutterProject(SAMPLE_MOBILE_SPEC),
  verifyLock: async () => undefined,
});
const PLIST =
  '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>app</string>\n</dict>\n</plist>\n';
const PODFILE = "# platform :ios, '13.0'\n";

/** a fake toolchain: records every command and lays down the files the real tools would */
function fake(
  opts: { xcodeVersion?: string; failAt?: string; failOut?: string; podfile?: boolean } = {},
) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args, cwd) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (opts.failAt && line.includes(opts.failAt))
      return { code: 1, timedOut: false, out: opts.failOut ?? 'boom' };
    if (cmd === 'xcodebuild' && args[0] === '-version')
      return opts.xcodeVersion === undefined
        ? {
            code: 1,
            timedOut: false,
            out: "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance",
          }
        : { code: 0, timedOut: false, out: `Xcode ${opts.xcodeVersion}\nBuild version 15F31d\n` };
    if (args[0] === '--version')
      return { code: 0, timedOut: false, out: '{"frameworkVersion": "3.35.7"}' };
    if (args[0] === 'create') {
      await mkdir(join(cwd, 'ios/Runner'), { recursive: true });
      await writeFile(join(cwd, 'ios/Runner/Info.plist'), PLIST);
    }
    // real `flutter create` writes no Podfile (verified); whether `pub get` writes one with plugins is NOT verified, so the fake makes it optional
    if (args[0] === 'pub' && opts.podfile !== false)
      await writeFile(join(cwd, 'ios/Podfile'), PODFILE);
    if (args[0] === 'build' && args[1] === 'ios') {
      await mkdir(join(cwd, 'build/ios/iphonesimulator/Runner.app'), { recursive: true });
      await writeFile(join(cwd, 'build/ios/iphonesimulator/Runner.app/Runner'), 'bin');
    }
    if (cmd === 'xcrun') return { code: 0, timedOut: false, out: '17.5\n' };
    return { code: 0, timedOut: false, out: 'ok' };
  };
  return { calls, exec };
}

describe('MacosIosRunner (fake executor: NOT VERIFIED against a real Xcode, B-iOS)', () => {
  it('refuses outside a declared build environment before running anything', async () => {
    const f = fake({ xcodeVersion: '15.4' });
    const r = new MacosIosRunner({
      probe: probe({ env: { PATH: '/usr/bin' } }),
      exec: f.exec,
      platform: 'darwin',
    });
    expect(r.supports('ios', 'debug')).toBe(false);
    await expect(r.run(input(), () => undefined)).rejects.toMatchObject({
      code: 'build_env_refused',
    });
    expect(f.calls).toEqual([]);
  });
  it('without full Xcode the failure is xcode_not_installed with an environment fix (never "repaired")', async () => {
    const f = fake();
    const r = new MacosIosRunner({ probe: probe(), exec: f.exec, platform: 'darwin' });
    await expect(r.run(input(), () => undefined)).rejects.toMatchObject({
      code: 'xcode_not_installed',
      parsed: { errors: [{ errorClass: 'xcode_not_installed', fix: 'environment' }] },
    });
    expect(f.calls).toEqual(['xcodebuild -version']); // nothing else ran
  });
  it('runs the no-codesign pipeline in order and records versions and the bundle hash; artifacts are empty, signed is false', async () => {
    const f = fake({ xcodeVersion: '15.4' });
    const r = new MacosIosRunner({ probe: probe(), exec: f.exec, platform: 'darwin' });
    expect(r.supports('ios', 'debug')).toBe(true);
    expect(r.supports('android', 'debug')).toBe(false);
    expect(r.supports('ios', 'release')).toBe(false);
    const out = await r.run(input(), () => undefined);
    const order = f.calls.map((c) => c.split(' ').slice(0, 3).join(' '));
    expect(order.indexOf('flutter create --platforms=ios')).toBeLessThan(
      order.indexOf('flutter pub get'),
    );
    expect(f.calls.some((c) => c.startsWith('flutter build ios --no-codesign --simulator'))).toBe(
      true,
    );
    expect(
      f.calls.some(
        (c) => c.startsWith('xcodebuild -workspace') && c.includes('CODE_SIGNING_ALLOWED=NO'),
      ),
    ).toBe(true);
    expect(f.calls.join('\n')).not.toMatch(
      /--release|exportArchive|-allowProvisioningUpdates|DEVELOPMENT_TEAM/,
    );
    expect(out.artifacts).toEqual([]);
    expect(out.signed).toBe(false);
    expect(out.toolchain).toMatchObject({
      runner: 'macos-ios',
      isolation: 'none',
      xcode: 'Xcode 15.4 Build version 15F31d',
      iphonesimulatorSdk: '17.5',
      ios: { appBundleFiles: 1 },
    });
    expect(String((out.toolchain.ios as { appBundleSha256: string }).appBundleSha256)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
  it('a failing stage carries parsed errors for the repair loop', async () => {
    const f = fake({
      xcodeVersion: '15.4',
      failAt: 'flutter analyze',
      failOut: "   error • Undefined name 'x' • lib/main.dart:3:1 • undefined_identifier",
    });
    const r = new MacosIosRunner({ probe: probe(), exec: f.exec, platform: 'darwin' });
    await expect(r.run(input(), () => undefined)).rejects.toMatchObject({
      stage: 'analyze',
      parsed: { errors: [{ errorClass: 'dart_undefined_name', file: 'lib/main.dart' }] },
    });
  });
  it('the supply-chain gate runs before anything compiles', async () => {
    const f = fake({ xcodeVersion: '15.4' });
    const r = new MacosIosRunner({ probe: probe(), exec: f.exec, platform: 'darwin' });
    const i = {
      ...input(),
      verifyLock: async () => {
        throw new Error('blocked');
      },
    };
    await expect(r.run(i, () => undefined)).rejects.toThrow('blocked');
    expect(f.calls.some((c) => c.includes('analyze') || c.includes('build ios'))).toBe(false);
  });
  it('the Info.plist/Podfile edits come from tool/nuzm-mobile.json only', async () => {
    const i = input();
    const m = JSON.parse(i.files['tool/nuzm-mobile.json']!) as Record<string, unknown>;
    i.files['tool/nuzm-mobile.json'] = JSON.stringify({ ...m, ios: { deploymentTarget: 99 } });
    const r = new MacosIosRunner({
      probe: probe(),
      exec: fake({ xcodeVersion: '15.4' }).exec,
      platform: 'darwin',
    });
    await expect(r.run(i, () => undefined)).rejects.toMatchObject({ code: 'manifest_invalid' });
  });
  it('hashTree is deterministic and content-sensitive', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const d = await mkdtemp(join(tmpdir(), 'nuzm-hash-'));
    await writeFile(join(d, 'a'), '1');
    const h1 = await hashTree(d);
    expect(await hashTree(d)).toEqual(h1);
    await writeFile(join(d, 'a'), '2');
    expect((await hashTree(d)).sha256).not.toBe(h1.sha256);
  });
});
