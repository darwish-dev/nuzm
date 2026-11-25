import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  failureFromStage,
  parseBuildOutput,
  repairAction,
  type BuildStage,
  type ParsedBuildError,
} from './index';

const DIR = join(__dirname, 'fixtures');
const fx = (n: string): string => readFileSync(join(DIR, n), 'utf8');
const ROOT = ['/work/build'];
const parse = (n: string, stage?: BuildStage, packageName?: string) =>
  parseBuildOutput(fx(n), {
    ...(stage ? { stage } : {}),
    ...(packageName ? { packageName } : {}),
    roots: ROOT,
  });
const classes = (es: ParsedBuildError[]) => es.map((e) => e.errorClass);

describe('Dart analyzer / compiler parser', () => {
  it('classifies each analyzer line and keeps project-relative file:line:column', () => {
    const r = parse('synthetic-dart-analyze.log', 'analyze');
    const byFile = (f: string) => r.errors.find((e) => e.file === f)!;
    expect(byFile('lib/ui/screens/list_screen.dart')).toMatchObject({
      errorClass: 'dart_type_error',
      line: 21,
      column: 34,
      code: 'argument_type_not_assignable',
      fix: 'edit_source',
    });
    expect(byFile('lib/ui/screens/list_screen.dart').targetFiles).toEqual([
      'lib/ui/screens/list_screen.dart',
    ]);
    expect(byFile('lib/core/theme.dart')).toMatchObject({
      errorClass: 'dart_undefined_name',
      line: 12,
    });
    expect(byFile('lib/ui/screens/home_screen.dart')).toMatchObject({
      errorClass: 'pub_missing_package',
      fix: 'edit_pubspec',
      targetFiles: ['pubspec.yaml'],
    });
    expect(byFile('lib/ui/shell.dart')).toMatchObject({
      errorClass: 'dart_missing_import',
      fix: 'edit_source',
    });
    expect(byFile('lib/app.dart')).toMatchObject({ errorClass: 'dart_missing_argument' });
    expect(byFile('lib/core/auth.dart')).toMatchObject({ errorClass: 'dart_type_error' });
    expect(byFile('lib/core/router.dart')).toMatchObject({ errorClass: 'dart_syntax_error' });
  });
  it('warnings are kept as warnings, infos are dropped, the summary line is ignored', () => {
    const r = parse('synthetic-dart-analyze.log', 'analyze');
    expect(r.errors.filter((e) => e.severity === 'warning')).toHaveLength(1);
    expect(r.errors.some((e) => /build_context/i.test(e.message))).toBe(false);
  });
  it('a generated file is never a repair target: the hint sends the model to the spec', () => {
    const e = parse('synthetic-dart-analyze.log', 'analyze').errors.find(
      (x) => x.file === 'lib/generated/app_spec.dart',
    )!;
    expect(e.targetFiles).toEqual([]);
    expect(e.hint).toMatch(/change the spec/);
  });
  it('parses front-end compiler errors, with the source excerpt, and reduces absolute paths under the root', () => {
    const r = parse('synthetic-dart-compiler.log', 'build_apk');
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatchObject({
      file: expect.stringMatching(/^lib\//),
      errorClass: expect.stringMatching(/dart_/),
    });
    expect(r.errors.find((e) => e.file === 'lib/core/auth.dart')).toBeTruthy(); // /work/build/lib/core/auth.dart -> lib/core/auth.dart
    expect(r.errors.find((e) => e.line === 21)!.excerpt).toContain('item.title');
  });
  it('an absolute path outside the project root is dropped, never echoed as a target', () => {
    const r = parseBuildOutput(
      "/Users/someone/.pub-cache/hosted/pub.dev/x-1.0.0/lib/x.dart:3:1: Error: Undefined name 'y'.",
      { stage: 'build_apk', roots: ROOT },
    );
    expect(r.errors[0]!.file).toBeUndefined();
    expect(r.errors[0]!.targetFiles).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('/Users/someone');
  });
});

describe('flutter test parser', () => {
  it('a failing test is test_failure with the location from the stack and never auto-deletes the test', () => {
    const r = parse('synthetic-flutter-test-fail.log', 'test');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      tool: 'flutter-test',
      errorClass: 'test_failure',
      file: 'test/widget_test.dart',
      line: 42,
    });
    expect(r.errors[0]!.hint).toMatch(/never delete or weaken a test/);
  });
  it('a test file that fails to load is test_compile_error plus the compiler error', () => {
    const r = parse('synthetic-flutter-test-load.log', 'test', 'app');
    expect(classes(r.errors)).toContain('test_compile_error');
    expect(r.errors.find((e) => e.errorClass === 'dart_missing_import')).toMatchObject({
      file: 'test/widget_test.dart',
      line: 5,
    }); // own package: a missing FILE, not a missing dependency
    expect(classes(parse('synthetic-flutter-test-load.log', 'test').errors)).toContain(
      'pub_missing_package',
    ); // unknown package name: treated as a dependency
  });
});

describe('pub parser', () => {
  it('missing package -> edit_pubspec with the package name', () => {
    const r = parse('synthetic-pub-missing.log', 'pub_get');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      errorClass: 'pub_missing_package',
      code: 'flutter_charts_pro',
      fix: 'edit_pubspec',
    });
    expect(r.errors[0]!.hint).toMatch(/allow-listed/);
  });
  it('version conflict and SDK constraint are told apart', () => {
    expect(classes(parse('synthetic-pub-conflict.log', 'pub_get').errors)).toEqual([
      'pub_version_conflict',
    ]);
    const sdk = parse('synthetic-pub-sdk.log', 'pub_get').errors;
    expect(sdk[0]).toMatchObject({ errorClass: 'pub_sdk_constraint', fix: 'edit_pubspec' });
    expect(sdk[0]!.hint).toMatch(/never change the pinned SDK constraint/);
  });
  it('a network failure is a retry, not a missing package', () => {
    const r = parse('synthetic-pub-network.log', 'pub_get');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ errorClass: 'pub_network', fix: 'retry' });
  });
});

describe('Gradle parser', () => {
  const one = (f: string) => parse(f, 'build_apk').errors[0]!;
  it('compileSdk mismatch -> edit the declarative android config, not Gradle', () => {
    expect(one('synthetic-gradle-compile-sdk.log')).toMatchObject({
      errorClass: 'gradle_compile_sdk_mismatch',
      fix: 'edit_android_config',
      targetFiles: ['tool/nuzm-mobile.json'],
      code: ':app:checkDebugAarMetadata',
    });
  });
  it('minSdk mismatch -> edit the declarative android config', () => {
    expect(one('synthetic-gradle-min-sdk.log')).toMatchObject({
      errorClass: 'gradle_min_sdk_mismatch',
      fix: 'edit_android_config',
      targetFiles: ['tool/nuzm-mobile.json'],
    });
  });
  it('Gradle wrapper / AGP / JDK skew -> regenerate the platform folder (no model, no Gradle edit)', () => {
    expect(one('synthetic-gradle-wrapper.log')).toMatchObject({
      errorClass: 'gradle_version_mismatch',
      fix: 'regenerate_platform',
      targetFiles: [],
    });
  });
  it('JDK problems are environment errors', () => {
    expect(one('synthetic-gradle-java.log')).toMatchObject({
      errorClass: 'gradle_java_version',
      fix: 'environment',
    });
    expect(one('synthetic-gradle-agp-java.log')).toMatchObject({
      errorClass: 'gradle_java_version',
      fix: 'environment',
    });
  });
  it('licence and missing SDK are environment errors that stop the loop', () => {
    expect(one('synthetic-gradle-licence.log')).toMatchObject({
      errorClass: 'gradle_licence_not_accepted',
      fix: 'environment',
    });
    expect(one('synthetic-gradle-sdk-missing.log')).toMatchObject({
      errorClass: 'gradle_sdk_missing',
      fix: 'environment',
    });
  });
  it('network and out-of-memory are retries', () => {
    expect(one('synthetic-gradle-network.log')).toMatchObject({
      errorClass: 'gradle_dependency_resolution',
      fix: 'retry',
    });
    expect(one('synthetic-gradle-oom.log')).toMatchObject({
      errorClass: 'gradle_out_of_memory',
      fix: 'retry',
    });
  });
  it('Kotlin compile errors are native-code errors with a project-relative location', () => {
    const e = parse('synthetic-gradle-kotlin.log', 'build_apk').errors.find(
      (x) => x.tool === 'kotlin',
    )!;
    expect(e).toMatchObject({
      errorClass: 'gradle_native_compile_error',
      line: 7,
      column: 20,
      file: 'android/app/src/main/kotlin/com/example/app/MainActivity.kt',
    });
    expect(e.targetFiles).toEqual([]);
  });
  it('an unrecognised Gradle failure is gradle_other / none, never silently clean', () => {
    const r = parse('synthetic-gradle-unknown.log', 'build_apk');
    expect(r.clean).toBe(false);
    expect(r.errors[0]).toMatchObject({ errorClass: 'gradle_other', fix: 'none' });
  });
});

describe('Xcode / CocoaPods parser (SIMULATED fixtures: no Xcode on the host, B-iOS)', () => {
  const one = (f: string, stage: BuildStage = 'build_ios') => parse(f, stage).errors[0]!;
  it('missing Xcode, licence, signing and destination are environment errors', () => {
    const nx = parse('synthetic-xcode-no-xcode.log', 'build_ios').errors;
    expect(classes(nx)).toEqual(
      expect.arrayContaining(['xcode_not_installed', 'cocoapods_missing']),
    );
    expect(nx.every((e) => e.fix === 'environment')).toBe(true);
    expect(one('synthetic-xcode-licence.log')).toMatchObject({
      errorClass: 'xcode_licence_not_accepted',
      fix: 'environment',
    });
    expect(one('synthetic-xcode-signing.log')).toMatchObject({
      errorClass: 'xcode_signing_required',
      fix: 'environment',
    });
    expect(one('synthetic-xcode-nodest.log', 'xcodebuild')).toMatchObject({
      errorClass: 'xcode_no_destination',
      fix: 'environment',
    });
  });
  it('deployment target -> edit the declarative ios config', () => {
    expect(one('synthetic-xcode-deployment.log')).toMatchObject({
      errorClass: 'xcode_deployment_target',
      fix: 'edit_ios_config',
      targetFiles: ['tool/nuzm-mobile.json'],
    });
  });
  it('Swift error is native: regenerate, never a project edit; missing module is distinguished', () => {
    expect(one('synthetic-xcode-swift.log')).toMatchObject({
      errorClass: 'xcode_swift_error',
      file: 'ios/Runner/AppDelegate.swift',
      line: 12,
      fix: 'regenerate_platform',
      targetFiles: [],
    });
    const m = parse('synthetic-xcode-module.log', 'build_ios').errors;
    expect(classes(m)).toContain('xcode_missing_module');
    expect(m.filter((e) => e.errorClass === 'xcode_missing_module').map((e) => e.code)).toEqual(
      expect.arrayContaining(['Flutter', 'shared_preferences_foundation']),
    );
  });
  it('CocoaPods failures', () => {
    expect(one('synthetic-pods.log', 'pod_install')).toMatchObject({
      errorClass: 'cocoapods_resolution',
      fix: 'retry',
    });
  });
});

describe('stage selection, ordering, safety', () => {
  it('a stage only runs its own parsers: Gradle text under analyze is not misread', () => {
    expect(parse('synthetic-gradle-compile-sdk.log', 'analyze').errors).toEqual([]);
  });
  it('without a stage every parser runs, root causes first (environment before source)', () => {
    const mixed = fx('synthetic-gradle-licence.log') + '\n' + fx('synthetic-dart-analyze.log');
    const r = parseBuildOutput(mixed, { roots: ROOT });
    expect(r.errors[0]!.fix).toBe('environment');
    expect(r.errors.at(-1)!.fix === 'edit_source' || r.errors.at(-1)!.severity === 'warning').toBe(
      true,
    );
  });
  it('a failed stage with no recognisable error is `unknown`, never clean', () => {
    const r = failureFromStage('something odd happened\n', 1, { stage: 'build_apk' });
    expect(r.clean).toBe(false);
    expect(r.errors[0]).toMatchObject({ errorClass: 'unknown', fix: 'none' });
    expect(failureFromStage('all good\n', 0, { stage: 'build_apk' }).clean).toBe(true);
  });
  it('ANSI codes and control characters are removed; output is capped', () => {
    const r = parseBuildOutput(
      "\u001b[31m   error • Undefined name 'x' • lib/main.dart:1:1 • undefined_identifier\u001b[0m\u0007",
      { stage: 'analyze' },
    );
    expect(r.errors[0]!.file).toBe('lib/main.dart');
    const many = Array.from(
      { length: 200 },
      (_, i) => `   error • Undefined name 'x${i}' • lib/a${i}.dart:1:1 • undefined_identifier`,
    ).join('\n');
    expect(parseBuildOutput(many, { stage: 'analyze' }).errors.length).toBe(50);
  });
  it('secrets in a log line never reach the excerpt or the message', () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP'; // built at run time so the repository scan stays clean
    const r = parseBuildOutput(
      `FAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed. https://user:hunter2@repo.example/x token=abc123 ${key}\n`,
      { stage: 'build_apk' },
    );
    const s = JSON.stringify(r);
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('abc123');
    expect(s).not.toContain(key);
  });
  it('every fixture parses to at least one error (nothing silently clean)', () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.log'))) {
      const r = parseBuildOutput(fx(f), { roots: ROOT });
      expect(r.errors.length, f).toBeGreaterThan(0);
    }
  });
});

describe('repairAction', () => {
  const act = (f: string, stage?: BuildStage) => repairAction(parse(f, stage)).action;
  it('environment faults stop the loop; they are never "repaired"', () => {
    expect(act('synthetic-gradle-licence.log', 'build_apk')).toBe('stop_environment');
    expect(act('synthetic-xcode-no-xcode.log', 'build_ios')).toBe('stop_environment');
  });
  it('Gradle skew regenerates the platform folder; network retries; Dart/pub go to the model', () => {
    expect(act('synthetic-gradle-wrapper.log', 'build_apk')).toBe('regenerate_platform');
    expect(act('synthetic-gradle-network.log', 'build_apk')).toBe('retry');
    expect(act('synthetic-dart-analyze.log', 'analyze')).toBe('model_patch');
    expect(act('synthetic-pub-missing.log', 'pub_get')).toBe('model_patch');
    expect(act('synthetic-gradle-min-sdk.log', 'build_apk')).toBe('model_patch');
  });
  it('unknown failures stop', () => {
    expect(act('synthetic-gradle-unknown.log', 'build_apk')).toBe('stop_unknown');
  });
});
