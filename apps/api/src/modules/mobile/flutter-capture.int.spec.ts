import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildFailure, LocalAndroidRunner, buildEnv } from './internal/builds/runner';
import { parseBuildOutput, type BuildStage } from './internal/builds/errors';
import { scrubHostPaths } from './internal/builds/errors/common';
import { SAMPLE_MOBILE_SPEC } from './internal/fixtures/sample-spec';
import { generateFlutterProject } from './internal/flutter/templates';

/**
 * LIVE round trip of the build-error parsers (P3-S06, target T5): break a copy of the Nuzm TEMPLATE project on purpose (first-party code, no AI-generated code), run the real
 * Flutter tools, save what they really printed as `captured-*.log` fixtures, and assert the parsers classify it. Skipped unless `MOBILE_CAPTURE_FIXTURES=1`; needs Flutter 3.35.7 and
 * pub.dev; runs `flutter pub get/analyze/test` (a few minutes). The Gradle case additionally needs `MOBILE_CAPTURE_GRADLE=1` (a full Android build, JDK 17 and licences accepted).
 * It runs the template only, never a generated project, and is run in the quiet window announced by the Master.
 */
const ON = process.env.MOBILE_CAPTURE_FIXTURES === '1';
const GRADLE = process.env.MOBILE_CAPTURE_GRADLE === '1';
const FIXTURES = join(__dirname, 'internal/builds/errors/fixtures');
const env = buildEnv();

function project(extra: Record<string, string>, pubspecEdit?: (t: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nuzm-capture-'));
  const files = { ...generateFlutterProject(SAMPLE_MOBILE_SPEC), ...extra };
  if (pubspecEdit) files['pubspec.yaml'] = pubspecEdit(files['pubspec.yaml']!);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}
function flutter(dir: string, args: string[]): { code: number | null; out: string } {
  const r = spawnSync('flutter', args, { cwd: dir, env, encoding: 'utf8', timeout: 10 * 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function save(name: string, cmd: string, out: string) {
  const v = spawnSync('flutter', ['--version', '--machine'], { env, encoding: 'utf8' }).stdout;
  const fv = /"frameworkVersion":\s*"([^"]+)"/.exec(v)?.[1] ?? 'unknown';
  const header = `# captured ${new Date().toISOString().slice(0, 10)} from: ${cmd} (Flutter ${fv}) on a deliberately broken copy of the Nuzm template; paths are relative to the project\n`;
  writeFileSync(
    join(FIXTURES, `captured-${name}.log`),
    header +
      scrubHostPaths(
        out.replace(/\/(?:private\/)?(?:var|tmp)\/[^\s:)]+?\/nuzm-capture-[^/\s]+\//g, ''),
      ),
  );
}
const parsed = (out: string, stage: BuildStage) => parseBuildOutput(out, { stage });

describe.skipIf(!ON)(
  'captured build-error fixtures from the real Flutter tools (template project only)',
  () => {
    it(
      'Dart analyzer: type error, undefined name, missing package, bad relative import',
      { timeout: 15 * 60_000 },
      () => {
        const dir = project({
          'lib/broken.dart': [
            "import 'package:nuzm_no_such_package/x.dart';",
            "import '../core/modles.dart';",
            'int f() => "not an int";',
            'final y = undefinedThing;',
            '',
          ].join('\n'),
        });
        try {
          expect(flutter(dir, ['pub', 'get']).code).toBe(0);
          const r = flutter(dir, ['analyze']);
          expect(r.code).not.toBe(0);
          save('dart-analyze', 'flutter analyze', r.out);
          const classes = parsed(r.out, 'analyze').errors.map((e) => e.errorClass);
          expect(classes).toEqual(
            expect.arrayContaining(['dart_type_error', 'dart_undefined_name']),
          );
          expect(
            classes.some((c) => c === 'pub_missing_package' || c === 'dart_missing_import'),
          ).toBe(true);
          expect(
            parsed(r.out, 'analyze').errors.every((e) => !e.file || !e.file.startsWith('/')),
          ).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it(
      'flutter test: a failing test and a test that does not compile',
      { timeout: 15 * 60_000 },
      () => {
        const dir = project({
          'test/broken_test.dart':
            "import 'package:flutter_test/flutter_test.dart';\nvoid main() { test('one is two', () { expect(1, 2); }); }\n",
        });
        try {
          expect(flutter(dir, ['pub', 'get']).code).toBe(0);
          const r = flutter(dir, ['test', 'test/broken_test.dart']);
          expect(r.code).not.toBe(0);
          save('flutter-test-fail', 'flutter test test/broken_test.dart', r.out);
          expect(parsed(r.out, 'test').errors.map((e) => e.errorClass)).toContain('test_failure');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it('pub get: a package that does not exist', { timeout: 10 * 60_000 }, () => {
      const dir = project({}, (t) =>
        t.replace('dependencies:\n', 'dependencies:\n  nuzm_no_such_package_xyz: ^1.0.0\n'),
      );
      try {
        const r = flutter(dir, ['pub', 'get']);
        expect(r.code).not.toBe(0);
        save('pub-missing', 'flutter pub get', r.out);
        expect(parsed(r.out, 'pub_get').errors.map((e) => e.errorClass)).toContain(
          'pub_missing_package',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(!GRADLE)(
      'Gradle: compileSdk too low for a dependency (the declarative android.compileSdk repair case; minSdk 21 was tried first and built fine on 2026-11-24)',
      { timeout: 25 * 60_000 },
      async () => {
        const files = generateFlutterProject(SAMPLE_MOBILE_SPEC);
        const m = JSON.parse(files['tool/nuzm-mobile.json']!) as Record<string, unknown>;
        files['tool/nuzm-mobile.json'] = JSON.stringify(
          { ...m, android: { compileSdk: 34 } },
          null,
          2,
        );
        const lines: string[] = [];
        const err = await new LocalAndroidRunner()
          .run(
            {
              buildId: '00000000-0000-7000-8000-0000000000c1',
              platform: 'android',
              profile: 'debug',
              files,
              verifyLock: async () => undefined,
            },
            (l) => lines.push(l),
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(BuildFailure);
        const out = lines.join('\n');
        save('gradle-compile-sdk', 'flutter build apk --debug (android.compileSdk=34)', out);
        expect(parsed(out, 'build_apk').errors.map((e) => e.errorClass)).toContain(
          'gradle_compile_sdk_mismatch',
        );
      },
    );
  },
);
