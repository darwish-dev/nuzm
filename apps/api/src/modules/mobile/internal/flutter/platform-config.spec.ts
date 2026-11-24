import { describe, expect, it } from 'vitest';
import {
  IOS_USAGE_PLACEHOLDER,
  applyAndroidSdkConfig,
  applyIosDeploymentTarget,
  applyIosPermissions,
  checkPlatformFiles,
  validatePlatformSettings,
} from './platform-config';

// shapes of the files `flutter create` (3.35.x) writes; hand-reduced, SIMULATED until the first captured create is added
const KTS = `android {
    namespace = "com.example.app"
    compileSdk = flutter.compileSdkVersion
    defaultConfig {
        applicationId = "com.example.app"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
    }
}`;
const GROOVY = `android {
    compileSdkVersion flutter.compileSdkVersion
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}`;
const PODFILE = `# Uncomment this line to define a global platform for your project\n# platform :ios, '13.0'\n\nproject 'Runner'`;
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>app</string>\n</dict>\n</plist>\n`;

describe('platform settings validation', () => {
  it('accepts the bounded numbers and nothing else', () => {
    expect(
      validatePlatformSettings({
        android: { minSdk: 23, compileSdk: 35 },
        ios: { deploymentTarget: 13 },
      }),
    ).toEqual([]);
    expect(validatePlatformSettings({})).toEqual([]);
    expect(validatePlatformSettings({ android: { minSdk: 10 } }).join()).toMatch(/21 to 34/);
    expect(validatePlatformSettings({ android: { compileSdk: 99 } }).join()).toMatch(/34 to 36/);
    expect(validatePlatformSettings({ android: { signingConfig: 'x' } }).join()).toMatch(
      /not an allowed setting/,
    );
    expect(validatePlatformSettings({ ios: { deploymentTarget: 12.5 } }).join()).toMatch(/integer/);
    expect(validatePlatformSettings({ android: 'x' }).join()).toMatch(/must be an object/);
  });
});

describe('applying settings to the created platform folders', () => {
  it('rewrites only the minSdk / compileSdk assignments (Kotlin DSL and Groovy)', () => {
    const k = applyAndroidSdkConfig(KTS, { minSdk: 23, compileSdk: 35 });
    expect(k).toContain('minSdk = 23');
    expect(k).toContain('compileSdk = 35');
    expect(k).toContain('targetSdk = flutter.targetSdkVersion'); // untouched
    const g = applyAndroidSdkConfig(GROOVY, { minSdk: 23 });
    expect(g).toContain('minSdkVersion 23');
    expect(g).toContain('compileSdkVersion flutter.compileSdkVersion');
  });
  it('throws instead of appending text to a build script when the anchor is missing', () => {
    expect(() => applyAndroidSdkConfig('android {}', { minSdk: 23 })).toThrow(/not found/);
  });
  it('sets the iOS deployment target in the Podfile, commented or not', () => {
    expect(applyIosDeploymentTarget(PODFILE, 14)).toContain("platform :ios, '14.0'");
    expect(applyIosDeploymentTarget("platform :ios, '12.0'\n", 15)).toBe("platform :ios, '15.0'\n");
    expect(() => applyIosDeploymentTarget('target "Runner"', 14)).toThrow();
  });
  it('adds usage strings for declared iOS permissions only, idempotently', () => {
    const p = applyIosPermissions(PLIST, ['internet', 'camera', 'location', 'notifications']);
    expect(p).toContain('<key>NSCameraUsageDescription</key>');
    expect(p).toContain('<key>NSLocationWhenInUseUsageDescription</key>');
    expect(p).not.toContain('NSPhotoLibraryUsageDescription');
    expect(p).toContain(IOS_USAGE_PLACEHOLDER);
    expect(applyIosPermissions(p, ['camera'])).toBe(p);
    expect(p).toMatch(/<\/dict>\n<\/plist>/);
  });
});

describe('platform file checks', () => {
  const manifest = (extra: string, app = '') =>
    `<manifest xmlns:android="x">\n    ${extra}\n    <application ${app}/>\n</manifest>`;
  it('accepts the declared permissions', () => {
    expect(
      checkPlatformFiles(
        {
          androidManifests: {
            m: manifest('<uses-permission android:name="android.permission.INTERNET"/>'),
          },
        },
        ['internet'],
      ),
    ).toEqual([]);
  });
  it('refuses an undeclared permission and cleartext traffic', () => {
    const i = checkPlatformFiles(
      {
        androidManifests: {
          'android/app/src/main/AndroidManifest.xml': manifest(
            '<uses-permission android:name="android.permission.READ_SMS"/>',
            'android:usesCleartextTraffic="true"',
          ),
        },
      },
      ['internet'],
    );
    expect(i.map((x) => x.rule).sort()).toEqual(['cleartext_traffic', 'undeclared_permission']);
    expect(i.find((x) => x.rule === 'undeclared_permission')!.detail).toMatch(/READ_SMS/);
  });
  it('refuses an ATS arbitrary-loads exception on iOS', () => {
    const plist = PLIST.replace(
      '<dict>',
      '<dict>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>',
    );
    expect(checkPlatformFiles({ infoPlist: plist }, ['internet']).map((x) => x.rule)).toEqual([
      'ats_arbitrary_loads',
    ]);
    expect(checkPlatformFiles({ infoPlist: PLIST }, ['internet'])).toEqual([]);
  });
});
