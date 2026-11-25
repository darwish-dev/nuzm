/**
 * Declarative platform settings of a generated Flutter project (P3-S06).
 *
 * The `android/` and `ios/` folders are NEVER stored in the project and NEVER written by a model: the build creates them with the pinned `flutter create`. Gradle files, Podfiles and
 * Xcode project files can execute arbitrary code during a build, so AI-written ones are not accepted anywhere (`analysis.ts` rejects them). What a model (or the repair loop) MAY
 * change are a few bounded numbers in `tool/nuzm-mobile.json`; this module validates them and applies them to the freshly created platform folders with exact, anchored edits. The
 * same functions check the created folders for cleartext traffic and for permissions that were not declared.
 */
export const ANDROID_BOUNDS = {
  minSdk: { min: 21, max: 34 },
  compileSdk: { min: 34, max: 36 },
} as const;
export const IOS_BOUNDS = { deploymentTarget: { min: 12, max: 17 } } as const;

export interface PlatformSettings {
  android?: { minSdk?: number; compileSdk?: number };
  ios?: { deploymentTarget?: number };
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Validate the optional `android` / `ios` blocks of tool/nuzm-mobile.json. Closed: unknown members are an error. */
export function validatePlatformSettings(m: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const block = (name: 'android' | 'ios', keys: Record<string, { min: number; max: number }>) => {
    const b = m[name];
    if (b === undefined) return;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      issues.push(`${name} must be an object`);
      return;
    }
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      const range = keys[k];
      if (!range) issues.push(`${name}.${k} is not an allowed setting`);
      else if (!isInt(v) || v < range.min || v > range.max)
        issues.push(`${name}.${k} must be an integer from ${range.min} to ${range.max}`);
    }
  };
  block('android', ANDROID_BOUNDS);
  block('ios', IOS_BOUNDS);
  return issues;
}

/**
 * Apply minSdk / compileSdk to the app module's Gradle file created by `flutter create`. Handles the Kotlin DSL (`build.gradle.kts`: `minSdk = flutter.minSdkVersion`) and the Groovy
 * DSL (`minSdkVersion flutter.minSdkVersion`). Only those assignments are rewritten; if neither form is found the function throws (a toolchain whose template differs must be
 * handled explicitly, never by appending text to a build script).
 */
export function applyAndroidSdkConfig(
  gradle: string,
  cfg: NonNullable<PlatformSettings['android']>,
): string {
  let out = gradle;
  const rewrite = (key: 'minSdk' | 'compileSdk', value: number | undefined) => {
    if (value === undefined) return;
    const kts = new RegExp(`^(\\s*${key})\\s*=\\s*[^\\n]+$`, 'm');
    const groovyName = key === 'minSdk' ? 'minSdkVersion' : 'compileSdkVersion';
    const groovy = new RegExp(`^(\\s*${groovyName})\\s+[^\\n]+$`, 'm');
    if (kts.test(out)) out = out.replace(kts, `$1 = ${value}`);
    else if (groovy.test(out)) out = out.replace(groovy, `$1 ${value}`);
    else throw new Error(`${key} assignment not found in the generated Gradle file`);
  };
  rewrite('minSdk', cfg.minSdk);
  rewrite('compileSdk', cfg.compileSdk);
  return out;
}

/** iOS deployment target in the Podfile created by `flutter create` (`# platform :ios, '13.0'` or `platform :ios, '13.0'`). */
export function applyIosDeploymentTarget(podfile: string, target: number): string {
  const re = /^[ \t]*#?[ \t]*platform :ios, '[\d.]+'[ \t]*$/m;
  if (!re.test(podfile)) throw new Error('platform :ios line not found in the generated Podfile');
  return podfile.replace(re, `platform :ios, '${target}.0'`);
}

/** iOS privacy usage strings for the declared permissions (placeholders: a release needs the real purpose text, which is a release-checklist item, not a T4 build requirement). */
export const IOS_USAGE_KEYS: Record<string, string> = {
  camera: 'NSCameraUsageDescription',
  location: 'NSLocationWhenInUseUsageDescription',
  photos: 'NSPhotoLibraryUsageDescription',
};
export const IOS_USAGE_PLACEHOLDER =
  'Declared in tool/nuzm-mobile.json. Replace with the real purpose before any release.';
export function applyIosPermissions(plist: string, permissions: string[]): string {
  let out = plist;
  for (const p of permissions) {
    const key = IOS_USAGE_KEYS[p];
    if (!key || out.includes(`<key>${key}</key>`)) continue;
    if (!/<\/dict>\s*<\/plist>/.test(out)) throw new Error('Info.plist has an unexpected shape');
    out = out.replace(
      /<\/dict>\s*<\/plist>/,
      `\t<key>${key}</key>\n\t<string>${IOS_USAGE_PLACEHOLDER}</string>\n</dict>\n</plist>`,
    );
  }
  return out;
}

export interface PlatformIssue {
  rule:
    | 'cleartext_traffic'
    | 'ats_arbitrary_loads'
    | 'undeclared_permission'
    | 'debuggable_release'
    | 'backup_enabled_with_secrets';
  file: string;
  detail: string;
}
const ANDROID_PERMISSION_NAMES: Record<string, string> = {
  internet: 'android.permission.INTERNET',
  camera: 'android.permission.CAMERA',
  location: 'android.permission.ACCESS_FINE_LOCATION',
  notifications: 'android.permission.POST_NOTIFICATIONS',
  photos: 'android.permission.READ_MEDIA_IMAGES',
};
/**
 * Check the created Android manifest(s) and iOS Info.plist: cleartext traffic and ATS exceptions are refused, and the only `uses-permission` entries allowed are the declared ones
 * (plugins add theirs through manifest merging at build time; that merged result is checked by `apkanalyzer manifest permissions` in the build pipeline).
 */
export function checkPlatformFiles(
  files: { androidManifests?: Record<string, string>; infoPlist?: string },
  declared: string[],
): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  const allowed = new Set(
    declared.map((d) => ANDROID_PERMISSION_NAMES[d]).filter((x): x is string => Boolean(x)),
  );
  for (const [path, xml] of Object.entries(files.androidManifests ?? {})) {
    if (/android:usesCleartextTraffic\s*=\s*"true"/.test(xml))
      issues.push({
        rule: 'cleartext_traffic',
        file: path,
        detail: 'android:usesCleartextTraffic="true"',
      });
    for (const m of xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)) {
      if (!allowed.has(m[1]!))
        issues.push({
          rule: 'undeclared_permission',
          file: path,
          detail: `${m[1]} is not declared in tool/nuzm-mobile.json`,
        });
    }
  }
  if (
    files.infoPlist !== undefined &&
    /<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(files.infoPlist)
  )
    issues.push({
      rule: 'ats_arbitrary_loads',
      file: 'ios/Runner/Info.plist',
      detail: 'NSAllowsArbitraryLoads is true',
    });
  return issues;
}
