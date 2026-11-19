import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAndroidRunner, buildEnv } from './internal/builds/runner';
import { SAMPLE_MOBILE_SPEC } from './internal/fixtures/sample-spec';
import { generateFlutterProject } from './internal/flutter/templates';
import { PINNED_TOOLCHAIN } from './internal/flutter/toolchain';
import { StaticPubAdvisories, evaluatePubLock } from './internal/policy/pub-policy';

/**
 * LOCAL evidence for S48/S49 (AC-M10-10 evidence only on a real CI runner: this runs on the developer's machine).
 * Skipped unless `MOBILE_FLUTTER_LOCAL=1` because it needs Flutter 3.35.7, the Android SDK and a network, and takes minutes.
 *  - template: `flutter pub get`, `flutter analyze` and `flutter test` on the rendered project (real results);
 *  - runner: the LOCAL Android runner (UNSIGNED, NOT ISOLATED) builds an APK from the rendered project; the resolved pubspec.lock passes the supply-chain policy.
 * The result is never isolation evidence and never a signed artifact.
 */
const ON = process.env.MOBILE_FLUTTER_LOCAL === '1';
const env = buildEnv();

describe.skipIf(!ON)(
  'Flutter template and local Android debug runner (labelled local, unsigned, non-isolated)',
  () => {
    it(
      'the rendered template passes flutter analyze and flutter test',
      { timeout: 15 * 60_000 },
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'nuzm-flutter-template-'));
        try {
          for (const [p, t] of Object.entries(generateFlutterProject(SAMPLE_MOBILE_SPEC))) {
            mkdirSync(dirname(join(dir, p)), { recursive: true });
            writeFileSync(join(dir, p), t);
          }
          const run = (args: string[]) =>
            execFileSync('flutter', args, {
              cwd: dir,
              env,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          expect(run(['--version', '--machine'])).toContain(
            `"frameworkVersion": "${PINNED_TOOLCHAIN.flutter}"`,
          );
          run(['pub', 'get']);
          expect(run(['analyze'])).toContain('No issues found');
          const test = run(['test']);
          expect(test).toContain('All tests passed');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it(
      'builds an unsigned debug APK; the resolved lockfile passes the pub policy before compiling',
      { timeout: 25 * 60_000 },
      async () => {
        const lines: string[] = [];
        let lockPackages = 0;
        const out = await new LocalAndroidRunner().run(
          {
            buildId: '00000000-0000-7000-8000-000000000001',
            platform: 'android',
            profile: 'debug',
            files: generateFlutterProject(SAMPLE_MOBILE_SPEC),
            verifyLock: async (lock) => {
              const r = await evaluatePubLock(lock, {
                allowedHosts: ['pub.dev'],
                advisories: new StaticPubAdvisories(),
              });
              lockPackages = r.packages.length;
              expect(r.issues).toEqual([]);
            },
          },
          (l) => lines.push(l),
        );
        const apk = out.artifacts[0]!;
        expect(apk.kind).toBe('apk');
        expect(apk.bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // an APK is a zip
        expect(apk.bytes.includes(Buffer.from('AndroidManifest.xml'))).toBe(true);
        expect(apk.bytes.length).toBeGreaterThan(1_000_000);
        expect(out.signed).toBe(false);
        expect(out.toolchain).toMatchObject({
          runner: 'local-android',
          isolation: 'none',
          flutter: PINNED_TOOLCHAIN.flutter,
          signed: false,
        });
        expect(lockPackages).toBeGreaterThan(20);
        expect(lockPackages).toBeLessThanOrEqual(200);
        console.log(
          `LOCAL-ANDROID-DEBUG apk=${apk.fileName} bytes=${apk.bytes.length} sha256=${createHash('sha256').update(apk.bytes).digest('hex')} lockPackages=${lockPackages}`,
        );
      },
    );
  },
);
