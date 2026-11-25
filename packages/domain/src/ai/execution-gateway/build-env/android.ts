import { ACCEPTABLE_RUNTIME_CLASSES } from '../runtime-spec';

/**
 * P3-S02 -> P3-S06: the DEFINITION of the isolated ANDROID BUILD ENVIRONMENT. It is data plus a validator, not an executor: it says what the environment must contain, how it is
 * confined and what may come out of it, and `validateAndroidBuildEnv` refuses a definition weaker than the baseline. P3-S06's build orchestrator consumes it and may only run
 * `flutter pub get`, `flutter analyze`, `flutter test` and `flutter build apk --debug|--release` inside an environment built from it, on a node that is attested for this class.
 *
 * Why a separate definition: Android builds are heavy (JVM, Gradle, a 5+ GB SDK), need more CPU, memory, disk and time than the Node profiles, and fetch from more registries
 * (Google Maven, Maven Central, pub.dev, Flutter's engine artifacts). They stay inside the SAME isolation model (gVisor sandbox per run, own network namespace, read-only rootfs,
 * constant environment, workspace quota, kill paths) with these differences, all explicit below: larger limits, a MIRROR-ONLY network class (every upstream is reached through the
 * egress proxy and an offline mirror; the build itself runs with `--offline` where the toolchain supports it), and a debug-signing policy.
 *
 * Nothing here was run. Every version marked `(V)` in `infra/runtime/profiles/android/android-build-env.json` is chosen and verified by the reviewer on the build host. The Android SDK
 * licence acceptance is a LEGAL act by a named human; the build script refuses to proceed without it and this repository never accepts it.
 */
export interface AndroidBuildEnv {
  schema: 'nuzm.android-build-env/1';
  runtimeClass: string;
  limits: {
    cpus: number;
    memoryMb: number;
    pids: number;
    diskMb: number;
    wallSeconds: number;
    outputKb: number;
    swapMb: number;
  };
  network: {
    class: 'mirror-only';
    /** host names the egress proxy allows for this environment (exact, port 443) */
    allowHosts: string[];
    /** the build runs offline against the mirror/cache wherever the tool supports it */
    offlineFirst: true;
  };
  toolchain: {
    jdk: { vendor: string; version: string; sha256: string };
    androidSdk: {
      cmdlineTools: string;
      sha256: string;
      platforms: string[];
      buildTools: string[];
      licenseAcceptedBy: string;
    };
    flutter: { version: string; sha256: string };
    gradle: { wrapperVersion: string; distributionSha256: string };
    caches: { gradleReadOnly: string; pubReadOnly: string };
  };
  commands: { id: string; argv: string[] }[];
  signing: {
    mode: 'debug-or-test-keystore';
    keystoreOrigin: 'generated-in-environment';
    productionKeysAllowed: false;
    storeSubmission: false;
  };
  outputs: {
    roots: string[];
    allowedExtensions: string[];
    maxFileBytes: number;
    hash: 'sha256';
    kinds: 'regular-files-only';
  };
  emulator: { insideEnvironment: false; note: string };
}
/** the only commands the environment may run: fixed argv, no shell, no free-form arguments */
export const ANDROID_ALLOWED_COMMANDS = [
  'flutter pub get --offline',
  'flutter analyze --no-pub',
  'flutter test --no-pub',
  'flutter build apk --debug --no-pub',
  'flutter build apk --release --no-pub',
] as const;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const FORBIDDEN_OUTPUT_EXT = ['.jks', '.keystore', '.p12', '.pem', '.key', '.env'];

export function validateAndroidBuildEnv(e: AndroidBuildEnv): string[] {
  const v: string[] = [];
  if (e.schema !== 'nuzm.android-build-env/1') v.push('schema_unknown');
  if (!(ACCEPTABLE_RUNTIME_CLASSES as readonly string[]).includes(e.runtimeClass))
    v.push('runtime_class_not_isolating');
  const l = e.limits;
  for (const k of ['cpus', 'memoryMb', 'pids', 'diskMb', 'wallSeconds', 'outputKb'] as const)
    if (!Number.isFinite(l[k]) || l[k] <= 0) v.push(`limit_missing_${k}`);
  if (l.swapMb !== 0) v.push('swap_allowed');
  if (
    l.cpus > 8 ||
    l.memoryMb > 12_288 ||
    l.diskMb > 32_768 ||
    l.wallSeconds > 3_600 ||
    l.pids > 4_096
  )
    v.push('limits_above_android_ceiling');
  if (e.network.class !== 'mirror-only') v.push('network_not_mirror_only');
  if (e.network.offlineFirst !== true) v.push('not_offline_first');
  if (e.network.allowHosts.length === 0 || e.network.allowHosts.length > 12)
    v.push('allow_hosts_count');
  for (const h of e.network.allowHosts)
    if (
      !HOST.test(h) ||
      h !== h.toLowerCase() ||
      /\.(internal|local|localhost|lan|corp|intranet|home|arpa)$/.test(h)
    )
      v.push('allow_host_invalid');
  const t = e.toolchain;
  for (const [k, s] of [
    ['jdk', t.jdk.sha256],
    ['androidSdk', t.androidSdk.sha256],
    ['flutter', t.flutter.sha256],
    ['gradle', t.gradle.distributionSha256],
  ] as const)
    if (!SHA.test(s)) v.push(`toolchain_${k}_not_pinned`);
  if (!t.androidSdk.licenseAcceptedBy || t.androidSdk.licenseAcceptedBy.trim().length < 3)
    v.push('android_licence_not_accepted_by_a_named_human');
  if (t.androidSdk.platforms.length === 0 || t.androidSdk.buildTools.length === 0)
    v.push('sdk_components_missing');
  if (!t.caches.gradleReadOnly.startsWith('/') || !t.caches.pubReadOnly.startsWith('/'))
    v.push('caches_not_absolute');
  const allowed = new Set<string>(ANDROID_ALLOWED_COMMANDS);
  if (e.commands.length === 0) v.push('commands_missing');
  for (const c of e.commands) if (!allowed.has(c.argv.join(' '))) v.push('command_not_allowed');
  if (
    e.signing.mode !== 'debug-or-test-keystore' ||
    e.signing.keystoreOrigin !== 'generated-in-environment'
  )
    v.push('signing_not_debug');
  if (e.signing.productionKeysAllowed !== false) v.push('production_keys_allowed');
  if (e.signing.storeSubmission !== false) v.push('store_submission_allowed');
  if (
    e.outputs.roots.length === 0 ||
    e.outputs.roots.some((r) => r.startsWith('/') || r.split('/').includes('..'))
  )
    v.push('output_roots_invalid');
  if (
    e.outputs.allowedExtensions.some((x) => FORBIDDEN_OUTPUT_EXT.includes(x)) ||
    e.outputs.allowedExtensions.length === 0
  )
    v.push('output_extension_forbidden');
  if (e.outputs.kinds !== 'regular-files-only') v.push('output_kinds');
  if (e.emulator.insideEnvironment !== false) v.push('emulator_inside_environment');
  return [...new Set(v)];
}
