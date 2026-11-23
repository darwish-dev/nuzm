import type { ModuleFact, RouteFact } from './types';
import { dirname, lines, rel, safeText } from './util';

/**
 * Route, module and screen extraction. Next.js routes come from FILE PATHS (the framework's own convention), NestJS and Flutter from line patterns in source text.
 * These are static heuristics with stated confidence; precise component and architecture analysis is the AST work of S-K2c. Every value that comes from source
 * is bounded and restricted to a route-like alphabet before it is stored.
 */
const ROUTE_CHARS = /^[\w\-/:.*{}[\](),@~%+ ]*$/;
const routeText = (s: string): string | null => (s.length <= 200 && ROUTE_CHARS.test(s) ? s : null);
const SRC_EXT = /\.(?:tsx|ts|jsx|js|mjs|mdx)$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function nextSegment(seg: string): string | null {
  if (/^\(.*\)$/.test(seg) && !/^\(\.{1,3}\)/.test(seg)) return null; // route group
  if (seg.startsWith('@')) return null; // parallel route slot
  if (/^\(\.{1,3}\)/.test(seg)) return seg.replace(/^\(\.{1,3}\)/, '');
  return seg;
}
export interface NextRoutes {
  routes: RouteFact[];
  hasAppDir: boolean;
  hasPagesDir: boolean;
  /** Files the content of which is needed (route handlers: exported HTTP methods). */
  handlerFiles: string[];
  middleware: string | null;
  localeSegment: string | null;
}
/** `files` are paths relative to the project root; `abs` maps them back to package paths. */
export function nextRoutes(
  project: string,
  files: string[],
  abs: (p: string) => string,
): NextRoutes {
  const out: NextRoutes = {
    routes: [],
    hasAppDir: false,
    hasPagesDir: false,
    handlerFiles: [],
    middleware: null,
    localeSegment: null,
  };
  for (const f of files) {
    const mw = /^(?:src\/)?middleware\.(?:ts|js)$/.exec(f);
    if (mw) out.middleware = abs(f);
    const app = /^((?:src\/)?app)\/(.*)$/.exec(f);
    if (app && SRC_EXT.test(f)) {
      out.hasAppDir = true;
      const parts = app[2]!.split('/');
      const file = parts.pop()!;
      const kind = /^page\.(?:tsx|ts|jsx|js|mdx)$/.test(file)
        ? 'next-app-page'
        : /^route\.(?:ts|js)$/.test(file)
          ? 'next-route-handler'
          : null;
      if (!kind) continue;
      const segs = parts.map(nextSegment).filter((s): s is string => s !== null);
      const path = `/${segs.join('/')}`;
      const loc = segs.find((s) => /^\[(?:locale|lang|language)\]$/.test(s));
      if (loc) out.localeSegment = abs(f);
      out.routes.push({
        kind,
        path: routeText(path) ?? '/(invalid)',
        methods: kind === 'next-route-handler' ? [] : ['GET'],
        dynamic: segs.some((s) => s.includes('[')),
        file: abs(f),
        project,
        confidence: 0.9,
      });
      if (kind === 'next-route-handler') out.handlerFiles.push(f);
      continue;
    }
    const pages = /^((?:src\/)?pages)\/(.*)$/.exec(f);
    if (pages && SRC_EXT.test(f) && !/\.(?:test|spec|stories)\./.test(f)) {
      out.hasPagesDir = true;
      const parts = pages[2]!.replace(SRC_EXT, '').split('/');
      const last = parts[parts.length - 1]!;
      if (['_app', '_document', '_error'].includes(last)) continue;
      if (last === 'index') parts.pop();
      const isApi = parts[0] === 'api';
      const path = `/${parts.join('/')}`;
      out.routes.push({
        kind: isApi ? 'next-pages-api' : 'next-pages-page',
        path: routeText(path) ?? '/(invalid)',
        methods: isApi ? [] : ['GET'],
        dynamic: parts.some((s) => s.includes('[')),
        file: abs(f),
        project,
        confidence: 0.85,
      });
    }
  }
  return out;
}
/** Exported HTTP method names of an App Router route handler. */
export function handlerMethods(text: string): string[] {
  const found = new Set<string>();
  for (const [, l] of lines(text, 3000)) {
    const m = /^\s*export\s+(?:async\s+)?(?:function|const)\s+([A-Z]+)\b/.exec(l);
    if (m && METHODS.includes(m[1]!)) found.add(m[1]!);
  }
  return [...found].sort();
}

export interface NestScan {
  routes: RouteFact[];
  modules: ModuleFact[];
  hasMain: boolean;
  globalPrefix: string | null;
  swagger: boolean;
  guards: number;
  controllers: number;
}
const NEST_HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
const arg = (s: string): string | null => {
  const m = /^\s*(?:\{[^}]*\bpath:\s*)?(['"`])([^'"`]{0,200})\1/.exec(s);
  return m ? m[2]! : null;
};
const join = (...p: (string | null)[]) =>
  `/${p
    .filter((x): x is string => !!x)
    .flatMap((x) => x.split('/'))
    .filter(Boolean)
    .join('/')}`;
/** One TypeScript file of a NestJS project. `file` is the package path. */
export function scanNestFile(project: string, file: string, text: string, into: NestScan): void {
  let prefix: string | null = null;
  let ctrlLine = 0;
  let pendingClass: 'controller' | 'module' | null = null;
  let pendingLine = 0;
  let ctrlName: string | null = null;
  const base = file.slice(file.lastIndexOf('/') + 1);
  for (const [n, l] of lines(text, 20_000)) {
    if (/NestFactory\.create/.test(l) && /^main\.ts$/.test(base)) into.hasMain = true;
    const gp = /setGlobalPrefix\(\s*(['"`])([^'"`]{0,60})\1/.exec(l);
    if (gp) into.globalPrefix = routeText(gp[2]!);
    if (/SwaggerModule\.setup\(/.test(l)) into.swagger = true;
    if (/@UseGuards\(/.test(l)) into.guards++;
    const c = /@Controller\(\s*(.*)$/.exec(l);
    if (c) {
      prefix = arg(c[1]!) ?? '';
      ctrlLine = n;
      pendingClass = 'controller';
      pendingLine = n;
      continue;
    }
    if (/^\s*@Module\(/.test(l)) {
      pendingClass = 'module';
      pendingLine = n;
      continue;
    }
    const cls = /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (cls && pendingClass && n - pendingLine <= 12) {
      const name = safeText(cls[1], 80);
      if (pendingClass === 'module')
        into.modules.push({ kind: 'nest-module', name, file, line: n, project, confidence: 0.9 });
      else {
        ctrlName = name;
        into.controllers++;
        into.modules.push({
          kind: 'nest-controller',
          name,
          file,
          line: ctrlLine,
          project,
          confidence: 0.9,
        });
      }
      pendingClass = null;
      continue;
    }
    if (prefix !== null) {
      const m = /^\s*@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(.*)$/.exec(l);
      if (m && NEST_HTTP.includes(m[1]!)) {
        const sub = arg(m[2]!);
        const path = join(prefix, sub);
        into.routes.push({
          kind: 'nest-controller-route',
          path: routeText(path) ?? '/(invalid)',
          methods: [m[1]!.toUpperCase()],
          dynamic: path.includes(':'),
          file,
          line: n,
          project,
          confidence: 0.85,
        });
      }
    }
  }
  void ctrlName;
}
export const newNestScan = (): NestScan => ({
  routes: [],
  modules: [],
  hasMain: false,
  globalPrefix: null,
  swagger: false,
  guards: 0,
  controllers: 0,
});

export interface FlutterScan {
  routes: RouteFact[];
  screens: ModuleFact[];
  hasMain: boolean;
  routers: Set<string>;
}
const WIDGET =
  /^\s*(?:abstract\s+)?class\s+([A-Z]\w*)\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|GetView(?:<[^>]*>)?|GetWidget(?:<[^>]*>)?)/;
export const newFlutterScan = (): FlutterScan => ({
  routes: [],
  screens: [],
  hasMain: false,
  routers: new Set(),
});
export function scanDartFile(project: string, file: string, text: string, into: FlutterScan): void {
  const isMain = /(?:^|\/)lib\/main\.dart$/.test(file);
  let goRouteAt = 0;
  for (const [n, l] of lines(text, 20_000)) {
    if (isMain && /\bvoid\s+main\s*\(/.test(l)) into.hasMain = true;
    const w = WIDGET.exec(l);
    if (w && /(?:Screen|Page|View)$/.test(w[1]!))
      into.screens.push({
        kind: 'flutter-screen',
        name: safeText(w[1], 80),
        file,
        line: n,
        project,
        confidence: 0.7,
      });
    if (/\bGoRoute\s*\(/.test(l)) {
      goRouteAt = n;
      into.routers.add('go_router');
    }
    if (goRouteAt && n - goRouteAt <= 4) {
      const p = /\bpath:\s*(['"])([^'"]{0,200})\1/.exec(l);
      if (p) {
        into.routes.push({
          kind: 'flutter-route',
          path: routeText(p[2]!) ?? '/(invalid)',
          methods: [],
          dynamic: p[2]!.includes(':'),
          file,
          line: n,
          project,
          confidence: 0.85,
        });
        goRouteAt = 0;
      }
    }
    const named = /^\s*(['"])(\/[^'"]{0,200})\1\s*:\s*\(/.exec(l);
    if (named) {
      into.routes.push({
        kind: 'flutter-route',
        path: routeText(named[2]!) ?? '/(invalid)',
        methods: [],
        dynamic: false,
        file,
        line: n,
        project,
        confidence: 0.7,
      });
      into.routers.add('named-routes');
    }
    const gp = /\bGetPage\s*\(\s*name:\s*(['"])([^'"]{0,200})\1/.exec(l);
    if (gp) {
      into.routes.push({
        kind: 'flutter-route',
        path: routeText(gp[2]!) ?? '/(invalid)',
        methods: [],
        dynamic: false,
        file,
        line: n,
        project,
        confidence: 0.8,
      });
      into.routers.add('getx');
    }
    const ar = /@(?:AutoRoute|RoutePage)\s*\(.*\bpath:\s*(['"])([^'"]{0,200})\1/.exec(l);
    if (ar) {
      into.routes.push({
        kind: 'flutter-route',
        path: routeText(ar[2]!) ?? '/(invalid)',
        methods: [],
        dynamic: false,
        file,
        line: n,
        project,
        confidence: 0.8,
      });
      into.routers.add('auto_route');
    }
    if (/\bonGenerateRoute\s*:/.test(l)) into.routers.add('onGenerateRoute');
  }
}
export const underRoot = (root: string, p: string) => rel(root, p);
export const parentDir = dirname;
