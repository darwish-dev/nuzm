import { describe, expect, it } from 'vitest';
import { analyzeProject } from './analysis';
import { SAMPLE_MOBILE_SPEC } from '../fixtures/sample-spec';
import { MOBILE_SPEC_SCHEMA, validateMobileSpec, type MobileSpec } from './spec';
import { dartString, declaredPermissions, generateFlutterProject, packageNameOf } from './templates';
import { PINNED_TOOLCHAIN } from './toolchain';

const clone = (): MobileSpec => JSON.parse(JSON.stringify(SAMPLE_MOBILE_SPEC)) as MobileSpec;

describe('mobile spec validation', () => {
  it('accepts the sample spec', () => expect(validateMobileSpec(SAMPLE_MOBILE_SPEC)).toEqual([]));
  it('is closed: unknown members, bad enums and bad ids are rejected', () => {
    const a = clone() as unknown as Record<string, unknown>;
    a.extra = 1;
    expect(validateMobileSpec(a).length).toBeGreaterThan(0);
    const b = clone();
    (b.screens[0] as { kind: string }).kind = 'webview';
    expect(validateMobileSpec(b).length).toBeGreaterThan(0);
    const c = clone();
    c.screens[0]!.id = 'Home Page';
    expect(validateMobileSpec(c).length).toBeGreaterThan(0);
  });
  it('rejects semantic errors: duplicate ids, unknown tabs, reserved ids, empty forms, control characters', () => {
    const dup = clone();
    dup.screens[1]!.id = 'home';
    expect(validateMobileSpec(dup).join()).toMatch(/unique/);
    const tab = clone();
    tab.navigation.tabs = ['home', 'nope'];
    expect(validateMobileSpec(tab).join()).toMatch(/not a screen/);
    const res = clone();
    res.screens[0]!.id = 'login';
    res.navigation = { initial: 'login', tabs: ['login'] };
    expect(validateMobileSpec(res).join()).toMatch(/reserved/);
    const form = clone();
    form.screens[2]!.fields = [];
    expect(validateMobileSpec(form).join()).toMatch(/needs fields/);
    const ctl = clone();
    ctl.app.name.en = 'Bad‮app';
    expect(validateMobileSpec(ctl).join()).toMatch(/bidi/);
  });
  it('the schema only uses keywords of the repository validator', () => {
    expect(JSON.stringify(MOBILE_SPEC_SCHEMA)).not.toMatch(/\$ref|patternProperties|propertyNames/);
  });
});

describe('Flutter template renderer', () => {
  const files = generateFlutterProject(SAMPLE_MOBILE_SPEC);
  it('is deterministic and complete', () => {
    expect(generateFlutterProject(SAMPLE_MOBILE_SPEC)).toEqual(files);
    for (const p of ['pubspec.yaml', 'lib/main.dart', 'lib/generated/app_spec.dart', 'test/widget_test.dart', 'analysis_options.yaml', 'tool/nuzm-mobile.json'])
      expect(files[p], p).toBeTruthy();
    expect(files['pubspec.yaml']).toContain(`name: ${packageNameOf(SAMPLE_MOBILE_SPEC)}`);
    expect(files['test/widget_test.dart']).toContain("package:field_tasks/app.dart");
    expect(JSON.parse(files['tool/nuzm-mobile.json']!).flutter).toBe(PINNED_TOOLCHAIN.flutter);
  });
  it('passes the static analysis gate', () => expect(analyzeProject(files)).toEqual([]));
  it('escapes everything that is syntax in Dart: spec text can never become code', () => {
    expect(dartString("a'b$c\\d\ne")).toBe("'a\\'b\\$c\\\\d\\ne'");
    const evil = clone();
    evil.app.name.en = "x'; Process.run('rm', ['-rf', '/']); '";
    evil.screens[0]!.body = { ar: 'مرحبا ${exit(1)}', en: '$evil ${1+1}' };
    expect(validateMobileSpec(evil)).toEqual([]);
    const out = generateFlutterProject(evil);
    const dart = out['lib/generated/app_spec.dart']!;
    expect(dart).toContain("x\\'; Process.run(");
    expect(dart).toContain('\\${exit(1)}');
    // the literal is closed and nothing outside a string literal contains the payload
    expect(analyzeProject(out).filter((i) => i.rule === 'forbidden_call').length).toBe(1); // the gate sees it too, inside a string
  });
  it('declares internet always and only the spec permissions beyond it', () => {
    expect(declaredPermissions(SAMPLE_MOBILE_SPEC)).toEqual(['internet']);
    const p = clone();
    p.permissions = ['camera'];
    expect(declaredPermissions(p)).toEqual(['internet', 'camera']);
    expect(JSON.parse(generateFlutterProject(p)['tool/nuzm-mobile.json']!).permissions).toEqual(['internet', 'camera']);
  });
  it('contains no signing material and no platform folders', () => {
    expect(Object.keys(files).filter((f) => /\.(jks|keystore|p12)$|key\.properties|^android\/|^ios\//.test(f))).toEqual([]);
  });
});

describe('analysis gate', () => {
  const base = generateFlutterProject(SAMPLE_MOBILE_SPEC);
  const withFile = (p: string, t: string) => ({ ...base, [p]: t });
  it('blocks secrets, signing material, process execution, ffi, cleartext http and unsafe paths', () => {
    expect(analyzeProject(withFile('lib/x.dart', "const k = 'AKIAABCDEFGHIJKLMNOP';")).map((i) => i.rule)).toContain('secret');
    expect(analyzeProject(withFile('android/key.properties', 'storePassword=abc')).map((i) => i.rule)).toContain('signing_material');
    expect(analyzeProject(withFile('app.jks', 'x')).map((i) => i.rule)).toContain('signing_material');
    expect(analyzeProject(withFile('lib/x.dart', "import 'dart:ffi';")).map((i) => i.rule)).toContain('forbidden_import');
    expect(analyzeProject(withFile('lib/x.dart', "void f() { Process.run('ls', []); }")).map((i) => i.rule)).toContain('forbidden_call');
    expect(analyzeProject(withFile('lib/x.dart', "const u = 'http://evil.example/x';")).map((i) => i.rule)).toContain('cleartext_url');
    expect(analyzeProject(withFile('../evil.dart', 'x')).map((i) => i.rule)).toContain('unsafe_path');
    const noMain = { ...base };
    delete noMain['lib/main.dart'];
    expect(analyzeProject(noMain).map((i) => i.rule)).toContain('missing_file');
  });
  it('allows loopback / emulator cleartext (local development)', () => {
    expect(analyzeProject(withFile('lib/x.dart', "const u = 'http://10.0.2.2:4000';"))).toEqual([]);
  });
});
