import { MAX_ERRORS, type BuildErrorClass, type FixKind, type ParsedBuildError } from './types';
import { cap, clean, projectPath, redact } from './common';

/**
 * Gradle / Android build output (what `flutter build apk` prints from the Gradle run). Understood:
 *  - the Gradle failure block (`FAILURE: Build failed with an exception.` / `* What went wrong:` + the next lines);
 *  - Kotlin compiler lines  `e: file:///abs/Foo.kt:12:5 Unresolved reference: bar`;
 *  - javac lines            `/abs/Foo.java:10: error: cannot find symbol`;
 *  - manifest merger        `uses-sdk:minSdkVersion 21 cannot be smaller than version 23 declared in library [:plugin]`;
 *  - AAR metadata           `Dependency 'x' requires libraries and applications that depend on it to compile against version 35 or later of the Android APIs`;
 *  - toolchain/environment  Gradle/AGP/JDK version messages, missing SDK packages, licences, heap exhaustion, network.
 * The `android/` folder is produced by the pinned `flutter create` and is never AI-written, so a Gradle mismatch is repaired by `regenerate_platform` (toolchain skew) or by the
 * bounded numbers in `tool/nuzm-mobile.json` (`android.minSdk`, `android.compileSdk`), never by editing Gradle files.
 */
interface Rule {
  re: RegExp;
  cls: BuildErrorClass;
  fix: FixKind;
  targets: string[];
  hint: string;
}
const RULES: Rule[] = [
  {
    re: /You have not accepted the license agreements|Failed to install the following Android SDK packages as some licen[sc]es have not been accepted|licen[sc]es? (?:have )?not (?:been )?accepted/i,
    cls: 'gradle_licence_not_accepted',
    fix: 'environment',
    targets: [],
    hint: 'Android SDK licences are not accepted in this build environment. Accepting a licence is a human action; the repair loop must stop and report it.',
  },
  {
    re: /SDK location not found|Failed to find Platform SDK|Failed to find (?:Build Tools|target with hash string)|No installed build tools found|Failed to find (?:platform|android).*sdk|ANDROID_HOME.*not (?:set|found)/i,
    cls: 'gradle_sdk_missing',
    fix: 'environment',
    targets: [],
    hint: 'A required Android SDK package (platform or build-tools) is not installed in the build environment. Install it in the environment image; no project change helps.',
  },
  {
    re: /Android Gradle plugin requires Java (\d+) to run|Unsupported class file major version \d+|Unsupported Java\. Your build is currently configured to use Java|incompatible with the Java version that Flutter is using|JAVA_HOME is not set|No Java compiler found|Could not (?:find|determine) java|invalid source release|Inconsistent JVM-target compatibility/i,
    cls: 'gradle_java_version',
    fix: 'environment',
    targets: [],
    hint: 'The JDK in the build environment does not match the toolchain (pinned: JDK 17). Fix the environment image; the project must not select a JDK.',
  },
  {
    re: /Minimum supported Gradle version is|Unsupported Gradle version|requires Gradle \d|incompatible with (?:the )?Gradle|Could not (?:find|resolve) (?:method|class).*(?:AGP|Android Gradle)|Android Gradle plugin version .* is (?:too old|not compatible)|Your project's Gradle version is incompatible|Plugin \[id: 'com\.android\.[a-z.]+'.*was not found|Could not get unknown property 'android'|Gradle project's.*is not supported/i,
    cls: 'gradle_version_mismatch',
    fix: 'regenerate_platform',
    targets: [],
    hint: 'The Gradle wrapper, Android Gradle plugin and JDK disagree. The android/ folder comes from the pinned `flutter create`: regenerate it with the pinned toolchain (no model edit, never edit Gradle files by hand).',
  },
  {
    re: /requires libraries and applications that depend on it to compile against version (\d+) or later of the Android APIs|compileSdkVersion\s*\d+.*(?:required|too low)|is currently compiled against android-\d+/i,
    cls: 'gradle_compile_sdk_mismatch',
    fix: 'edit_android_config',
    targets: ['tool/nuzm-mobile.json'],
    hint: 'A dependency needs a higher compileSdk. Raise `android.compileSdk` in tool/nuzm-mobile.json to the required API level (not above the installed platform) or drop the dependency.',
  },
  {
    re: /minSdkVersion (\d+) cannot be smaller than version (\d+) declared in library|uses-sdk:minSdkVersion|Manifest merger failed.*minSdk/i,
    cls: 'gradle_min_sdk_mismatch',
    fix: 'edit_android_config',
    targets: ['tool/nuzm-mobile.json'],
    hint: 'A dependency needs a higher minSdk. Raise `android.minSdk` in tool/nuzm-mobile.json to the required level, or drop the dependency.',
  },
  {
    re: /Java heap space|OutOfMemoryError|GC overhead limit exceeded|Metaspace|Gradle build daemon disappeared unexpectedly|Expiring Daemon because JVM heap space is exhausted/i,
    cls: 'gradle_out_of_memory',
    fix: 'retry',
    targets: [],
    hint: 'The Gradle daemon ran out of memory. Raise the environment memory limit (not a project change) and retry once.',
  },
  {
    re: /Could not resolve (?:all (?:task )?dependencies|[\w.-]+:[\w.-]+:[\w.+-]+)|Could not (?:GET|HEAD) '|Could not download|Connect to .+ failed|Read timed out|Unknown host|UnknownHostException|Could not find [\w.-]+:[\w.-]+:/i,
    cls: 'gradle_dependency_resolution',
    fix: 'retry',
    targets: [],
    hint: 'Gradle could not download a dependency (registry mirror unreachable or the artifact is not mirrored). In the offline-mirror environment this is an environment problem; retry within the limit, then stop. A project edit cannot add an unmirrored artifact.',
  },
];

const KOTLIN = /^e:\s+(?:file:\/\/)?(\S+?\.kt):(\d+):(\d+)\s+(.+)$/;
const JAVAC = /^(\S+?\.java):(\d+):\s+error:\s+(.+)$/;

export function parseGradle(raw: string, roots: readonly string[] = []): ParsedBuildError[] {
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
    const k = KOTLIN.exec(l);
    if (k) {
      const file = projectPath(k[1]!, roots);
      push({
        tool: 'kotlin',
        errorClass: 'gradle_native_compile_error',
        severity: 'error',
        message: cap(redact(k[4]!), 500),
        ...(file ? { file } : {}),
        line: Number(k[2]),
        column: Number(k[3]),
        fix: 'regenerate_platform',
        targetFiles: [],
        hint: 'Native Kotlin code is part of the generated platform folder or a plugin, not of the project model. Regenerate the platform folder; if it recurs, a plugin is incompatible with the toolchain: remove or replace the dependency.',
        excerpt: cap(redact(l), 600),
      });
      continue;
    }
    const j = JAVAC.exec(l);
    if (j) {
      const file = projectPath(j[1]!, roots);
      push({
        tool: 'java',
        errorClass: 'gradle_native_compile_error',
        severity: 'error',
        message: cap(redact(j[3]!), 500),
        ...(file ? { file } : {}),
        line: Number(j[2]),
        fix: 'regenerate_platform',
        targetFiles: [],
        hint: 'Native Java code is part of the generated platform folder or a plugin. Regenerate the platform folder; if it recurs, remove or replace the plugin dependency.',
        excerpt: cap(redact([l, lines[i + 1] ?? ''].join('\n')), 600),
      });
      continue;
    }
    for (const r of RULES) {
      if (!r.re.test(l)) continue;
      const block = [l.trim()];
      // include the task line that precedes ("Execution failed for task ':app:...'") when present
      for (let b = i - 1; b >= Math.max(0, i - 14); b--) {
        const t = lines[b]!.trim();
        if (/^Execution failed for task/.test(t)) {
          block.unshift(t);
          break;
        }
      }
      const task = /task '([^']+)'/.exec(block[0] ?? '')?.[1];
      const ver =
        /(?:version|compile against version|android-|Java|Gradle version is) ?(\d+(?:\.\d+)?)/i.exec(
          l,
        )?.[1];
      push({
        tool: 'gradle',
        errorClass: r.cls,
        severity: 'error',
        message: cap(redact(l.trim()), 500),
        ...(task ? { code: task } : ver ? { code: ver } : {}),
        fix: r.fix,
        targetFiles: r.targets,
        hint: r.hint,
        excerpt: cap(redact(block.join('\n')), 700),
      });
      break;
    }
  }
  // a Gradle failure block with no rule match: report it once as gradle_other, with the "What went wrong" text, so the loop never sees a silent failure
  if (out.length === 0) {
    const w = lines.findIndex((x) => /^\* What went wrong:/.test(x.trim()));
    if (w >= 0) {
      const body = lines
        .slice(w + 1, w + 5)
        .map((x) => x.trim())
        .filter(Boolean);
      push({
        tool: 'gradle',
        errorClass: 'gradle_other',
        severity: 'error',
        message: cap(redact(body[0] ?? 'Gradle build failed'), 500),
        fix: 'none',
        targetFiles: [],
        hint: 'Unrecognised Gradle failure. Show the excerpt to the model once; if it cannot name a project-level cause, stop and report.',
        excerpt: cap(body.map(redact).join('\n'), 700),
      });
    } else if (
      /Gradle task \w+ failed with exit code \d+|FAILURE: Build failed/.test(lines.join('\n'))
    ) {
      push({
        tool: 'gradle',
        errorClass: 'gradle_other',
        severity: 'error',
        message: 'Gradle build failed without a recognised cause',
        fix: 'none',
        targetFiles: [],
        hint: 'No cause could be parsed from the log.',
        excerpt: cap(
          redact(
            lines
              .filter((x) => x.trim())
              .slice(-6)
              .join('\n'),
          ),
          700,
        ),
      });
    }
  }
  return out;
}
