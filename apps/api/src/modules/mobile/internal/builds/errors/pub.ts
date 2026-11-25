import { MAX_ERRORS, type ParsedBuildError } from './types';
import { cap, clean, redact } from './common';

/**
 * `flutter pub get` / `dart pub get` failures. Formats (public pub tool output):
 *   Because app depends on foo any which doesn't exist (could not find package foo at https://pub.dev), version solving failed.
 *   Could not find package "foo" at https://pub.dev.
 *   Because x depends on y ^2.0.0 and z depends on y ^1.0.0, version solving failed.
 *   The current Dart SDK version is 3.9.2. Because app requires SDK version >=3.10.0 <4.0.0, version solving failed.
 *   Failed host lookup: 'pub.dev'   /   Got socket error trying to find package foo at https://pub.dev.
 */
export function parsePub(raw: string): ParsedBuildError[] {
  const text = clean(raw);
  const lines = text.split('\n');
  const out: ParsedBuildError[] = [];
  const push = (e: Omit<ParsedBuildError, 'tool' | 'severity'>) => {
    if (out.length < MAX_ERRORS) out.push({ tool: 'pub', severity: 'error', ...e });
  };
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // network first: it must not be mistaken for a missing package
    if (
      /Failed host lookup|Got socket error trying to find package|Connection (?:refused|reset|timed out)|SocketException|HandshakeException|TlsException/i.test(
        l,
      )
    ) {
      if (seen.has('net')) continue;
      seen.add('net');
      push({
        errorClass: 'pub_network',
        message: cap(redact(l.trim()), 500),
        fix: 'retry',
        targetFiles: [],
        hint: 'The package registry could not be reached. This is an environment problem: retry within the retry limit, never edit the project to work around it.',
        excerpt: cap(redact(l.trim()), 400),
      });
      continue;
    }
    const sdk = /requires SDK version [^,]+, version solving failed/.test(l);
    if (sdk) {
      push({
        errorClass: 'pub_sdk_constraint',
        message: cap(redact(l.trim()), 500),
        fix: 'edit_pubspec',
        targetFiles: ['pubspec.yaml'],
        hint: 'A package needs a different Dart SDK than the pinned toolchain. Pick the allow-listed constraint of that package or remove the package; never change the pinned SDK constraint.',
        excerpt: cap(redact(l.trim()), 400),
      });
      continue;
    }
    const miss =
      /Could not find package "([^"]+)" at (\S+?)\.?$/.exec(l) ??
      /depends on ([a-z0-9_]+) (?:any|[^\s]+) which doesn't exist \(could not find package ([a-z0-9_]+)/.exec(
        l,
      );
    if (miss) {
      const name = miss[1] ?? 'unknown';
      if (seen.has('miss:' + name)) continue;
      seen.add('miss:' + name);
      push({
        errorClass: 'pub_missing_package',
        message: cap(redact(l.trim()), 500),
        code: name,
        fix: 'edit_pubspec',
        targetFiles: ['pubspec.yaml'],
        hint: `Package "${name}" does not exist on the registry (a misspelling or an invented package). Replace it with an allow-listed package that does the job, or remove the dependency and the code that uses it.`,
        excerpt: cap(redact(l.trim()), 400),
      });
      continue;
    }
    const conflict =
      /^(?:Because|So, because) .+(?:version solving failed|which is incompatible)/.exec(l.trim());
    if (conflict || /version solving failed/.test(l)) {
      const block = [l.trim()];
      for (
        let j = i + 1;
        j < lines.length &&
        block.length < 4 &&
        lines[j]!.trim() &&
        !/^(\*|\[|Failed|Process|exit)/.test(lines[j]!.trim());
        j++
      )
        block.push(lines[j]!.trim());
      const msg = cap(redact(block.join(' ')), 500);
      const key = 'conflict:' + msg.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      push({
        errorClass: 'pub_version_conflict',
        message: msg,
        fix: 'edit_pubspec',
        targetFiles: ['pubspec.yaml'],
        hint: 'Two dependencies need incompatible versions. Use exactly the allow-listed constraints; drop the package that cannot be satisfied.',
        excerpt: cap(redact(block.join('\n')), 600),
      });
    }
  }
  return out;
}
