import { MAX_ERRORS, type BuildErrorClass, type FixKind, type ParsedBuildError } from './types';
import { cap, clean, projectPath, redact } from './common';

/**
 * Xcode / iOS output of `flutter build ios --no-codesign`, `xcodebuild` and `pod install`. NOT VERIFIED against a live Xcode run (B-iOS: no full Xcode on the owner's Mac yet): the
 * patterns are written from the documented Xcode/CocoaPods/Flutter message formats and tested on hand-written fixtures. The first real iOS run must add its captured log to
 * `fixtures/` and fix whatever this parser misses.
 */
interface Rule {
  re: RegExp;
  cls: BuildErrorClass;
  tool: ParsedBuildError['tool'];
  fix: FixKind;
  targets: string[];
  hint: string;
}
const ENV =
  'The iOS build environment (Xcode, licence, CocoaPods, signing mode) is wrong; no project patch helps. Stop and report.';
const RULES: Rule[] = [
  {
    re: /xcrun: error: unable to find utility "xcodebuild"|requires Xcode, but active developer directory|Xcode installation is incomplete|xcode-select: error|not a developer tool or in PATH/i,
    cls: 'xcode_not_installed',
    tool: 'xcode',
    fix: 'environment',
    targets: [],
    hint: 'Full Xcode is not installed or not selected (B-iOS). ' + ENV,
  },
  {
    re: /Xcode.*license (?:agreement|has not been accepted)|You have not agreed to the Xcode license|agreeing to the (?:Xcode\/iOS )?license|sudo xcodebuild -license/i,
    cls: 'xcode_licence_not_accepted',
    tool: 'xcode',
    fix: 'environment',
    targets: [],
    hint: 'The Xcode licence is not accepted. Accepting it is a human action. ' + ENV,
  },
  {
    re: /Signing for "[^"]+" requires a development team|No profile for team|requires a provisioning profile|Code Signing Error|No signing certificate|CodeSign failed|errSecInternalComponent/i,
    cls: 'xcode_signing_required',
    tool: 'xcode',
    fix: 'environment',
    targets: [],
    hint: 'T4 builds use --no-codesign and a simulator destination; a signing error means the wrong build mode was used. Fix the build command, never add a team, profile or certificate to the project.',
  },
  {
    re: /IPHONEOS_DEPLOYMENT_TARGET.*is set to ([\d.]+), but the range of supported deployment target versions|deployment target.*(?:is set to|too low)|requires.*iOS ([\d.]+) or (?:later|newer)|Minimum deployment target.*([\d.]+)/i,
    cls: 'xcode_deployment_target',
    tool: 'xcode',
    fix: 'edit_ios_config',
    targets: ['tool/nuzm-mobile.json'],
    hint: 'A dependency or the Xcode SDK needs a different iOS deployment target. Set `ios.deploymentTarget` in tool/nuzm-mobile.json within the supported range, or drop the dependency.',
  },
  {
    re: /No such module '([^']+)'|Module '([^']+)' not found|could not build (?:Objective-C )?module '([^']+)'/i,
    cls: 'xcode_missing_module',
    tool: 'swift',
    fix: 'regenerate_platform',
    targets: [],
    hint: 'A native module is missing: usually `pod install` did not run or ran against another toolchain. Regenerate the ios/ folder and re-run pod install; if it recurs a plugin is incompatible: remove it.',
  },
  {
    re: /CocoaPods not installed|pod: command not found|CocoaPods.*(?:not|isn't) installed|Warning: CocoaPods not installed/i,
    cls: 'cocoapods_missing',
    tool: 'cocoapods',
    fix: 'environment',
    targets: [],
    hint: 'CocoaPods is not installed in the build environment. ' + ENV,
  },
  {
    re: /\[!\] CocoaPods could not find compatible versions for pod|\[!\] Unable to find a specification for|The sandbox is not in sync with the Podfile\.lock|CDN: trunk.*(?:Error|failed)|Error installing|pod install.*(?:failed|error)/i,
    cls: 'cocoapods_resolution',
    tool: 'cocoapods',
    fix: 'retry',
    targets: [],
    hint: 'CocoaPods could not resolve a pod (trunk unreachable or pod incompatible with the deployment target). Retry within the limit; if the same pod fails twice, remove the Flutter plugin that needs it.',
  },
  {
    re: /Unable to find a destination matching the provided destination specifier|Unable to find a device matching|No simulator runtime|Failed to find a suitable device/i,
    cls: 'xcode_no_destination',
    tool: 'xcode',
    fix: 'environment',
    targets: [],
    hint: 'No simulator destination is available (no iOS runtime installed). Install an iOS simulator runtime; the build itself can still be validated with `flutter build ios --no-codesign`.',
  },
];
const SWIFT_DIAG = /^(\S+?\.(?:swift|m|mm|h|c|cpp)):(\d+):(\d+):\s+(error|warning):\s+(.+)$/;

export function parseXcode(raw: string, roots: readonly string[] = []): ParsedBuildError[] {
  const lines = clean(raw).split('\n');
  const out: ParsedBuildError[] = [];
  const seen = new Set<string>();
  const push = (e: ParsedBuildError) => {
    const k = `${e.errorClass}|${e.file ?? ''}|${e.line ?? ''}|${e.message.slice(0, 80)}`;
    if (!seen.has(k) && out.length < MAX_ERRORS) {
      seen.add(k);
      out.push(e);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const d = SWIFT_DIAG.exec(l);
    if (d && d[4] === 'error') {
      const msg = d[5]!;
      const missingModule = RULES.find((r) => r.cls === 'xcode_missing_module')!.re.test(msg);
      if (!missingModule) {
        const file = projectPath(d[1]!, roots);
        push({
          tool: 'swift',
          errorClass: 'xcode_swift_error',
          severity: 'error',
          message: cap(redact(msg), 500),
          ...(file ? { file } : {}),
          line: Number(d[2]),
          column: Number(d[3]),
          fix: 'regenerate_platform',
          targetFiles: [],
          hint: 'Native Swift/Objective-C source belongs to the generated ios/ folder or a plugin, not to the project model. Regenerate the platform folder; if it recurs remove or replace the plugin.',
          excerpt: cap(redact([l, lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n')), 700),
        });
        continue;
      }
    }
    for (const r of RULES) {
      if (!r.re.test(l)) continue;
      const code = /No such module '([^']+)'|Module '([^']+)' not found/i.exec(l);
      push({
        tool: r.tool,
        errorClass: r.cls,
        severity: 'error',
        message: cap(redact(l.trim()), 500),
        ...(code ? { code: code[1] ?? code[2] ?? '' } : {}),
        fix: r.fix,
        targetFiles: r.targets,
        hint: r.hint,
        excerpt: cap(redact(l.trim()), 500),
      });
      break;
    }
  }
  if (
    out.length === 0 &&
    /Xcode build failed|Failed to build iOS app|\*\* BUILD FAILED \*\*|Error \(Xcode\)/.test(
      lines.join('\n'),
    )
  ) {
    push({
      tool: 'xcode',
      errorClass: 'xcode_other',
      severity: 'error',
      message: 'Xcode build failed without a recognised cause',
      fix: 'none',
      targetFiles: [],
      hint: 'No cause could be parsed from the log. Show the excerpt to the model once, then stop.',
      excerpt: cap(
        redact(
          lines
            .filter((x) => x.trim())
            .slice(-8)
            .join('\n'),
        ),
        700,
      ),
    });
  }
  return out;
}
