import { describe, expect, it } from 'vitest';
import {
  ANDROID_PERMISSION,
  MockBuildRunner,
  UnavailableBuildRunner,
  applyAndroidPermissions,
  buildEnv,
} from './runner';

const MANIFEST =
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application android:label="x"/>\n</manifest>\n';

describe('build runner helpers', () => {
  it('buildEnv passes only the allow-list: no database URL, token or secret ever reaches a build process', () => {
    const e = buildEnv({
      PATH: '/bin',
      HOME: '/h',
      JAVA_HOME: '/j',
      DATABASE_URL: 'postgres://u:p@h/d',
      AI_SECRET_CANARIES: 'CANARY-X-0001',
      NUZM_API_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 'k',
    });
    expect(Object.keys(e).sort()).toEqual([
      'CI',
      'CLI_DISABLE_ANALYTICS',
      'FLUTTER_SUPPRESS_ANALYTICS',
      'HOME',
      'JAVA_HOME',
      'PATH',
    ]);
  });
  it('adds only declared permissions to the manifest, idempotently', () => {
    const once = applyAndroidPermissions(MANIFEST, ['internet', 'camera']);
    expect(once).toContain(`android:name="${ANDROID_PERMISSION.internet}"`);
    expect(once).toContain(`android:name="${ANDROID_PERMISSION.camera}"`);
    expect(once).not.toContain('ACCESS_FINE_LOCATION');
    expect(applyAndroidPermissions(once, ['internet', 'camera'])).toBe(once);
    expect(applyAndroidPermissions(MANIFEST, ['bogus'])).toBe(MANIFEST); // unknown names add nothing
  });
  it('capability: the unavailable runner supports nothing; the mock supports Android debug only unless iOS is switched on for a test', () => {
    const u = new UnavailableBuildRunner();
    expect(u.supports()).toBe(false);
    const m = new MockBuildRunner();
    expect(m.supports('android', 'debug')).toBe(true);
    expect(m.supports('android', 'release')).toBe(false);
    expect(m.supports('ios', 'debug')).toBe(false);
  });
});
