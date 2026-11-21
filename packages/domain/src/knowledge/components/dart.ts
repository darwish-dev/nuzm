import {
  LIMITS,
  emptyFacts,
  safeName,
  type ComponentFact,
  type FileFacts,
  type PropFact,
} from './types';
import { lines } from '../detect/util';

/**
 * Lexical Dart analyzer (S-K2c, interim for D-45): comments and string contents are blanked, then declarations are read by brace matching. It is not a Dart parser: it
 * extracts what Flutter projects declare in a regular way (widgets, state classes, state holders, providers, constructors' parameters, widget constructor calls in `build`,
 * imports, `GoRoute` → screen links). Everything it cannot read with certainty is simply absent; nothing is guessed. Linear in the size of the file.
 */
const WIDGET_BASES = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'ConsumerWidget',
  'ConsumerStatefulWidget',
  'HookWidget',
  'HookConsumerWidget',
  'GetView',
  'GetWidget',
]);
const HOLDER_BASES = new Set([
  'ChangeNotifier',
  'Bloc',
  'Cubit',
  'StateNotifier',
  'Notifier',
  'AsyncNotifier',
  'GetxController',
  'ValueNotifier',
]);

/** Blanks comments and the CONTENT of strings (newlines kept) so offsets and lines stay valid. */
export function blank(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
    } else if (c === '/' && d === '*') {
      let depth = 1;
      out.push('  ');
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          out.push('  ');
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          out.push('  ');
          i += 2;
        } else {
          out.push(src[i] === '\n' ? '\n' : ' ');
          i++;
        }
      }
    } else if (c === '"' || c === "'") {
      const raw = i > 0 && src[i - 1] === 'r';
      const triple = src[i + 1] === c && src[i + 2] === c;
      const q = triple ? c.repeat(3) : c;
      out.push(q);
      i += q.length;
      while (i < n) {
        if (!raw && src[i] === '\\') {
          out.push(' ', src[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
        } else if (src.startsWith(q, i)) {
          out.push(q);
          i += q.length;
          break;
        } else if (!triple && src[i] === '\n')
          break; // unterminated: stop at the line end
        else {
          out.push(src[i] === '\n' ? '\n' : ' ');
          i++;
        }
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}
/** Index of the matching closer for every opener (`{ ( [`), in one pass. */
function matches(s: string): Int32Array {
  const m = new Int32Array(s.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') stack.push(i);
    else if (c === '}' || c === ')' || c === ']') {
      const o = stack.pop();
      if (o !== undefined) m[o] = i;
    }
  }
  return m;
}
const lineStarts = (s: string): number[] => {
  const a = [0];
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) a.push(i + 1);
  return a;
};
const lineAt = (starts: number[], off: number): number => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};
/** Top-level split on commas, ignoring nesting. */
function splitParams(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of body) {
    if ('({[<'.includes(c)) depth++;
    else if (')}]>'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === ',' && depth <= 1) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Length of the longest line, without splitting the text. */
export function longestLine(s: string): number {
  let max = 0;
  let start = 0;
  for (let i = s.indexOf('\n'); ; i = s.indexOf('\n', start)) {
    const end = i < 0 ? s.length : i;
    if (end - start > max) max = end - start;
    if (i < 0) break;
    start = i + 1;
  }
  return max;
}

export function analyzeDart(src: string): FileFacts {
  const facts = emptyFacts('dart');
  if (longestLine(src) > LIMITS.maxLine) return emptyFacts('dart', 'minified');
  if (src.includes('\u0000')) return emptyFacts('dart', 'parse_error');

  // imports and routes come from the ORIGINAL lines (they need the string contents)
  let goAt = 0;
  let goPath: string | null = null;
  for (const [n, l] of lines(src, 20_000)) {
    const im = /^\s*(import|export|part)\s+['"]([^'"]{1,300})['"]/.exec(l);
    if (im) {
      const spec = im[2]!;
      if (!spec.startsWith('dart:') && facts.imports.length < LIMITS.maxImportsPerFile)
        facts.imports.push({
          spec,
          kind: spec.startsWith('package:') ? 'dart-package' : 'dart-relative',
          names: [],
          line: n,
          style: false,
          asset: false,
        });
      if (im[1] === 'export' && !spec.startsWith('dart:')) facts.reexports.push({ spec, line: n });
    }
    if (/\bGoRoute\s*\(/.test(l)) {
      goAt = n;
      goPath = null;
    }
    if (goAt && n - goAt <= 12) {
      const p = /\bpath:\s*(['"])([^'"]{0,200})\1/.exec(l);
      if (p && goPath === null) goPath = p[2]!;
      const b =
        /\b(?:builder|pageBuilder)\s*:.*?(?:=>|return)\s*(?:const\s+)?(?:\w+\.)?([A-Z]\w*)\s*\(/.exec(
          l,
        ) ?? /(?:=>|return)\s*(?:const\s+)?([A-Z]\w*)\s*\(/.exec(l);
      if (
        b &&
        goPath !== null &&
        safeName(b[1]) &&
        ![
          'MaterialPage',
          'CupertinoPage',
          'NoTransitionPage',
          'CustomTransitionPage',
          'Scaffold',
        ].includes(b[1]!)
      ) {
        if (facts.routeRefs.length < 500)
          facts.routeRefs.push({ path: goPath, target: b[1]!, line: n });
        goAt = 0;
      }
    }
  }

  const s = blank(src);
  const starts = lineStarts(s);
  const match = matches(s);
  facts.hasTheme = /\bThemeData\s*\(/.test(s);
  const comps: ComponentFact[] = [];
  const classRe =
    /(?:^|[\s;{}])(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+|mixin\s+)*class\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  const bodyOf = new Map<string, { open: number; close: number }>();
  while ((m = classRe.exec(s)) !== null && comps.length < LIMITS.maxComponentsPerFile) {
    const name = safeName(m[1]);
    const nameAt = m.index + m[0].length - m[1]!.length;
    const open = s.indexOf('{', nameAt);
    if (!name || open < 0 || open - nameAt > 500) continue;
    const close = match[open] ?? -1;
    if (close < 0) continue;
    const header = s.slice(nameAt + m[1]!.length, open);
    const ext =
      /\bextends\s+([A-Za-z_][\w.]*)(?:\s*<([^{]*?)>)?(?=\s|$|\bwith\b|\bimplements\b)/.exec(
        header,
      );
    const base = ext ? ext[1]!.split('.').pop()! : null;
    const baseGeneric = ext?.[2] ? ext[2].trim() : null;
    bodyOf.set(name, { open, close });
    const exported = !name.startsWith('_');
    if (!base) continue;
    const body = s.slice(open + 1, close);
    const line = lineAt(starts, nameAt);
    if (WIDGET_BASES.has(base)) {
      const stateful = base === 'StatefulWidget' || base === 'ConsumerStatefulWidget';
      comps.push({
        name,
        kind: stateful ? 'flutter-stateful-widget' : 'flutter-widget',
        framework: 'flutter',
        line,
        exported,
        isDefault: false,
        props: ctorProps(name, body),
        hooks: [],
        children: stateful ? [] : buildChildren(body, name),
        decorators: [],
        links: [],
      });
    } else if (base === 'State' || base === 'ConsumerState') {
      const widget = baseGeneric ? safeName(baseGeneric.split(/[<,\s]/)[0]) : null;
      comps.push({
        name,
        kind: 'flutter-state',
        framework: 'flutter',
        line,
        exported,
        isDefault: false,
        props: [],
        hooks: [],
        children: buildChildren(body, name),
        decorators: [],
        links: widget ? [{ relation: 'state_of', target: widget }] : [],
      });
    } else if (HOLDER_BASES.has(base)) {
      comps.push({
        name,
        kind: 'flutter-state-holder',
        framework: 'flutter',
        line,
        exported,
        isDefault: false,
        props: [],
        hooks: [],
        children: [],
        decorators: [base],
        links: [],
      });
    }
  }
  // a StatefulWidget renders what its State class builds: fold the State's children into the widget (same file)
  for (const st of comps.filter((c) => c.kind === 'flutter-state')) {
    const w = comps.find(
      (c) => c.name === st.links[0]?.target && c.kind === 'flutter-stateful-widget',
    );
    if (w)
      w.children = [...new Set([...w.children, ...st.children])].slice(
        0,
        LIMITS.maxChildrenPerComponent,
      );
  }
  // Riverpod and friends: top-level `final fooProvider = XProvider(...)`
  const provRe = /^\s*(?:final|const)\s+([a-z_]\w*Provider)\s*=\s*([A-Za-z]*Provider)\b/gm;
  while ((m = provRe.exec(s)) !== null && comps.length < LIMITS.maxComponentsPerFile) {
    const name = safeName(m[1]);
    if (name)
      comps.push({
        name,
        kind: 'flutter-provider',
        framework: 'flutter',
        line: lineAt(starts, m.index + m[0].indexOf(m[1]!)),
        exported: !name.startsWith('_'),
        isDefault: false,
        props: [],
        hooks: [],
        children: [],
        decorators: [m[2]!],
        links: [],
      });
  }
  facts.components = comps;
  facts.exports = [...new Set(comps.filter((c) => c.exported).map((c) => c.name))].sort();
  if (comps.length >= LIMITS.maxComponentsPerFile) facts.truncated = true;
  return facts;
}

/** Parameters of the generative constructor `Name(...)` or `const Name(...)`, with types resolved from `final T field;` declarations. */
function ctorProps(name: string, body: string): PropFact[] {
  const fieldType = new Map<string, string>();
  for (const f of body.matchAll(
    /(?:^|[;{}\s])(?:final|late\s+final|var|late)\s+([A-Za-z_][\w<>?,.\s]{0,80}?)\s+([a-z_]\w*)\s*[;=]/g,
  ))
    fieldType.set(f[2]!, f[1]!.trim().replace(/\s+/g, ' '));
  const re = new RegExp(`(?:^|[\\s;{}])(?:const\\s+)?${name}\\s*\\(`);
  const cm = re.exec(body);
  if (!cm) return [];
  const open = cm.index + cm[0].length - 1;
  // find the matching ")" within the body
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length && i < open + 4000; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [];
  const inner = body.slice(open + 1, close);
  const props: PropFact[] = [];
  let named = false;
  let optionalPositional = false;
  for (const raw of splitParams(inner)) {
    let p = raw.trim();
    if (p.startsWith('{')) {
      named = true;
      p = p.slice(1).trim();
    } else if (p.startsWith('[')) {
      optionalPositional = true;
      p = p.slice(1).trim();
    }
    p = p.replace(/[}\]]+\s*$/, '').trim();
    if (!p) continue;
    const required = !named && !optionalPositional;
    const noReq = p
      .replace(/\brequired\b/, '')
      .replace(/=.*$/s, '')
      .trim();
    const tm = /^(?:this|super)\.([A-Za-z_]\w*)$/.exec(noReq);
    let pname: string | null;
    let type: string | null;
    if (tm) {
      pname = tm[1]!;
      type = fieldType.get(pname) ?? null;
    } else {
      const parts = noReq.split(/\s+/);
      pname = parts[parts.length - 1]!;
      type = parts.length > 1 ? parts.slice(0, -1).join(' ') : null;
    }
    if (!safeName(pname) || pname === 'key') continue;
    if (props.length < LIMITS.maxPropsPerComponent)
      props.push({
        name: pname,
        type: type && type.length <= 60 ? type : null,
        required: /\brequired\b/.test(p) || (required && !(type ?? '').endsWith('?')),
      });
  }
  return props;
}
/** Widget constructor calls inside `build(...)`: `Name(`, `const Name(`, `Name.named(`. */
function buildChildren(body: string, self: string): string[] {
  const bm = /\bWidget\s+build\s*\(/.exec(body);
  if (!bm) return [];
  const open = body.indexOf('{', bm.index);
  const arrow = body.indexOf('=>', bm.index);
  let seg: string;
  if (open >= 0 && (arrow < 0 || open < arrow)) {
    let depth = 0;
    let end = body.length;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    seg = body.slice(open, end);
  } else if (arrow >= 0) seg = body.slice(arrow, arrow + 8000);
  else return [];
  const out = new Set<string>();
  for (const m of seg.matchAll(/(?<![\w.])([A-Z][A-Za-z0-9_]*)(?:\.[a-z_]\w*)?\s*\(/g)) {
    const n = m[1]!;
    if (n !== self && safeName(n)) out.add(n);
    if (out.size >= LIMITS.maxChildrenPerComponent) break;
  }
  return [...out].sort();
}
