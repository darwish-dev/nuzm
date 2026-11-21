import type {
  ManifestCapability,
  DependencyFact,
  Detection,
  DetectionCategory,
  Evidence,
} from './types';
import { declaredVersion, ev, levelOf, round, sortEvidence } from './util';

/** What a detector may ask about one project. Built by the orchestrator from text it already read. */
export interface Ctx {
  root: string;
  /** Package paths owned by this project (files of nested projects excluded). */
  files: string[];
  /** First owned file whose project-relative path matches. */
  file(re: RegExp): string | null;
  dir(name: string): string | null;
  dep(
    eco: DependencyFact['ecosystem'],
    name: string,
  ): (DependencyFact & { path: string }) | undefined;
  nodePath: string | null;
  pubPath: string | null;
  /** Project-relative text of a stored owned file (cached by the orchestrator), or null. */
  scriptsText: string;
}
const W = { runtime: 0.6, dev: 0.4, peer: 0.3, optional: 0.35 } as const;

class Score {
  private parts: Evidence[] = [];
  private total = 0;
  notes: string[] = [];
  add(w: number, e: Evidence) {
    this.total += w;
    this.parts.push(e);
  }
  get empty() {
    return this.parts.length === 0;
  }
  done(
    id: string,
    name: string,
    category: DetectionCategory,
    version: string | null,
    versionSource: Detection['versionSource'],
    cap = 0.99,
  ): Detection {
    const confidence = round(Math.min(cap, this.total));
    return {
      id,
      name,
      category,
      version,
      versionSource,
      confidence,
      level: levelOf(confidence),
      evidence: sortEvidence(this.parts),
      notes: this.notes,
    };
  }
}
const depEv = (d: DependencyFact & { path: string }) =>
  ev('dependency', d.path, `${d.name}@${d.range ?? '*'}`, d.line);
function version(
  d: (DependencyFact & { path: string }) | undefined,
): [string | null, Detection['versionSource']] {
  if (!d) return [null, null];
  if (d.resolved) return [d.resolved, 'lockfile'];
  const v = declaredVersion(d.range);
  return [v, v ? 'declared' : null];
}

interface Simple {
  id: string;
  name: string;
  category: DetectionCategory;
  eco: DependencyFact['ecosystem'];
  deps: string[];
  /** Project-relative config file patterns that add evidence. */
  configs?: RegExp[];
  extra?: { re: RegExp; w: number; kind: Evidence['kind'] }[];
}
/** Data-driven detectors: a dependency (the strong signal) plus optional config files. */
const SIMPLE: Simple[] = [
  { id: 'react', name: 'React', category: 'framework', eco: 'npm', deps: ['react'] },
  {
    id: 'react-native',
    name: 'React Native',
    category: 'framework',
    eco: 'npm',
    deps: ['react-native'],
    configs: [/(^|\/)metro\.config\.(js|cjs|ts)$/],
  },
  {
    id: 'expo',
    name: 'Expo',
    category: 'framework',
    eco: 'npm',
    deps: ['expo'],
    configs: [/(^|\/)app\.json$/],
  },
  {
    id: 'vue',
    name: 'Vue',
    category: 'framework',
    eco: 'npm',
    deps: ['vue'],
    configs: [/(^|\/)vue\.config\.(js|ts)$/],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    category: 'framework',
    eco: 'npm',
    deps: ['nuxt'],
    configs: [/(^|\/)nuxt\.config\.(js|ts|mjs)$/],
  },
  {
    id: 'angular',
    name: 'Angular',
    category: 'framework',
    eco: 'npm',
    deps: ['@angular/core'],
    configs: [/(^|\/)angular\.json$/],
  },
  {
    id: 'svelte',
    name: 'Svelte',
    category: 'framework',
    eco: 'npm',
    deps: ['svelte'],
    configs: [/(^|\/)svelte\.config\.(js|ts)$/],
  },
  { id: 'express', name: 'Express', category: 'framework', eco: 'npm', deps: ['express'] },
  { id: 'fastify', name: 'Fastify', category: 'framework', eco: 'npm', deps: ['fastify'] },
  { id: 'koa', name: 'Koa', category: 'framework', eco: 'npm', deps: ['koa'] },
  { id: 'hono', name: 'Hono', category: 'framework', eco: 'npm', deps: ['hono'] },
  {
    id: 'tailwindcss',
    name: 'Tailwind CSS',
    category: 'tool',
    eco: 'npm',
    deps: ['tailwindcss'],
    configs: [/(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/],
  },
  {
    id: 'prisma',
    name: 'Prisma',
    category: 'tool',
    eco: 'npm',
    deps: ['prisma', '@prisma/client'],
    configs: [/(^|\/)prisma\/schema\.prisma$/],
  },
  { id: 'typeorm', name: 'TypeORM', category: 'tool', eco: 'npm', deps: ['typeorm'] },
  {
    id: 'drizzle',
    name: 'Drizzle ORM',
    category: 'tool',
    eco: 'npm',
    deps: ['drizzle-orm'],
    configs: [/(^|\/)drizzle\.config\.(ts|js)$/],
  },
  {
    id: 'vite',
    name: 'Vite',
    category: 'tool',
    eco: 'npm',
    deps: ['vite'],
    configs: [/(^|\/)vite\.config\.(ts|js|mjs)$/],
  },
  {
    id: 'storybook',
    name: 'Storybook',
    category: 'tool',
    eco: 'npm',
    deps: ['storybook', '@storybook/react', '@storybook/nextjs'],
    configs: [/(^|\/)\.storybook\/main\.(ts|js)$/],
  },
  {
    id: 'dart-frog',
    name: 'Dart Frog',
    category: 'framework',
    eco: 'pub',
    deps: ['dart_frog'],
    configs: [/(^|\/)routes\/index\.dart$/],
  },
  { id: 'shelf', name: 'Shelf', category: 'framework', eco: 'pub', deps: ['shelf'] },
  {
    id: 'serverpod',
    name: 'Serverpod',
    category: 'framework',
    eco: 'pub',
    deps: ['serverpod', 'serverpod_flutter'],
  },
  {
    id: 'flutter-bloc',
    name: 'flutter_bloc',
    category: 'library',
    eco: 'pub',
    deps: ['flutter_bloc', 'bloc'],
  },
  {
    id: 'riverpod',
    name: 'Riverpod',
    category: 'library',
    eco: 'pub',
    deps: ['flutter_riverpod', 'riverpod', 'hooks_riverpod'],
  },
  { id: 'provider', name: 'Provider', category: 'library', eco: 'pub', deps: ['provider'] },
  { id: 'getx', name: 'GetX', category: 'library', eco: 'pub', deps: ['get'] },
  { id: 'go-router', name: 'go_router', category: 'library', eco: 'pub', deps: ['go_router'] },
  {
    id: 'django',
    name: 'Django',
    category: 'framework',
    eco: 'pip',
    deps: ['django'],
    configs: [/(^|\/)manage\.py$/],
  },
  { id: 'flask', name: 'Flask', category: 'framework', eco: 'pip', deps: ['flask'] },
  { id: 'fastapi', name: 'FastAPI', category: 'framework', eco: 'pip', deps: ['fastapi'] },
  {
    id: 'laravel',
    name: 'Laravel',
    category: 'framework',
    eco: 'composer',
    deps: ['laravel/framework'],
    configs: [/(^|\/)artisan$/],
  },
];
export function simpleDetections(c: Ctx): Detection[] {
  const out: Detection[] = [];
  for (const r of SIMPLE) {
    const found = r.deps.map((n) => c.dep(r.eco, n)).filter((d): d is NonNullable<typeof d> => !!d);
    if (found.length === 0) continue;
    const s = new Score();
    const best = found.sort((a, b) => W[b.kind] - W[a.kind])[0]!;
    s.add(W[best.kind], depEv(best));
    if (best.kind === 'dev' && r.category === 'framework')
      s.notes.push('declared only as a development dependency');
    for (const f of found.slice(1)) s.add(0.05, depEv(f));
    for (const re of r.configs ?? []) {
      const f = c.file(re);
      if (f) s.add(0.25, ev('config', f));
    }
    const [v, src] = version(best);
    out.push(s.done(r.id, r.name, r.category, v, src));
  }
  return out;
}

/** Next.js: the dependency, its config, and the route convention (computed by the orchestrator and passed in). */
export function nextDetection(
  c: Ctx,
  routes: { hasApp: boolean; hasPages: boolean; sample: string | null },
): Detection | null {
  const d = c.dep('npm', 'next');
  if (!d) return null;
  const s = new Score();
  s.add(W[d.kind], depEv(d));
  const cfg =
    c.file(/^next\.config\.(js|mjs|cjs|ts)$/) ?? c.file(/(^|\/)next\.config\.(js|mjs|cjs|ts)$/);
  if (cfg) s.add(0.25, ev('config', cfg));
  if (routes.sample)
    s.add(0.15, ev('directory', routes.sample, routes.hasApp ? 'app router' : 'pages router'));
  if (/\bnext (?:dev|build|start)\b/.test(c.scriptsText))
    s.add(0.05, ev('script', c.nodePath ?? c.root, 'next dev/build/start'));
  if (d.kind === 'dev') s.notes.push('declared only as a development dependency');
  if (!routes.hasApp && !routes.hasPages) s.notes.push('no app/ or pages/ route files were found');
  const [v, src] = version(d);
  return s.done('nextjs', 'Next.js', 'framework', v, src);
}
export function nestDetection(
  c: Ctx,
  scan: { hasMain: string | null; modules: number },
): Detection | null {
  const d = c.dep('npm', '@nestjs/core') ?? c.dep('npm', '@nestjs/common');
  if (!d) return null;
  const s = new Score();
  s.add(W[d.kind], depEv(d));
  const cfg = c.file(/(^|\/)nest-cli\.json$/);
  if (cfg) s.add(0.25, ev('config', cfg));
  if (scan.hasMain) s.add(0.1, ev('file', scan.hasMain, 'NestFactory.create'));
  if (scan.modules > 0)
    s.add(0.1, ev('source', c.nodePath ?? c.root, `${scan.modules} @Module/@Controller classes`));
  if (d.kind === 'dev') s.notes.push('declared only as a development dependency');
  if (!scan.hasMain) s.notes.push('no main.ts with NestFactory.create was found');
  const [v, src] = version(c.dep('npm', '@nestjs/core') ?? d);
  return s.done('nestjs', 'NestJS', 'framework', v, src);
}
export function nodeDetection(
  c: Ctx,
  node: { engines: Record<string, string>; bin: boolean },
  serverFramework: Evidence | null,
): Detection | null {
  if (!c.nodePath) return null;
  const s = new Score();
  s.add(0.15, ev('manifest', c.nodePath));
  if (node.engines.node)
    s.add(0.4, ev('manifest', c.nodePath, `engines.node ${node.engines.node}`));
  const nvm = c.file(/(^|\/)(\.nvmrc|\.node-version)$/);
  if (nvm) s.add(0.3, ev('config', nvm));
  const types = c.dep('npm', '@types/node');
  if (types) s.add(0.2, depEv(types));
  if (serverFramework) s.add(0.5, serverFramework);
  if (node.bin) s.add(0.3, ev('manifest', c.nodePath, 'bin'));
  if (/(^|\s)node\s+\S/.test(c.scriptsText)) s.add(0.3, ev('script', c.nodePath, 'node …'));
  const v = declaredVersion(node.engines.node ?? null);
  const d = s.done('nodejs', 'Node.js', 'runtime', v, v ? 'declared' : null);
  if (d.confidence < 0.5)
    d.notes.push('a package.json only: Node.js as tooling, not shown to be the runtime');
  return d;
}
export function typescriptDetection(c: Ctx): Detection | null {
  const d = c.dep('npm', 'typescript');
  const cfg = c.file(/(^|\/)tsconfig(\.[\w-]+)?\.json$/);
  if (!d && !cfg) return null;
  const s = new Score();
  if (d) s.add(0.5, depEv(d));
  if (cfg) s.add(0.4, ev('config', cfg));
  const [v, src] = version(d);
  return s.done('typescript', 'TypeScript', 'language', v, src);
}
export function dartDetections(
  c: Ctx,
  pub: {
    sdk: string | null;
    flutterSdk: boolean;
    hasFlutterSection: boolean;
    platforms: string[];
    usesMain: string | null;
    dartFiles: number;
  },
): Detection[] {
  if (!c.pubPath) return [];
  const out: Detection[] = [];
  const s = new Score();
  s.add(0.7, ev('manifest', c.pubPath, 'pubspec.yaml'));
  if (pub.dartFiles > 0)
    s.add(
      0.2,
      ev('directory', c.root === '.' ? 'lib' : `${c.root}/lib`, `${pub.dartFiles} .dart files`),
    );
  const lints = c.file(/(^|\/)analysis_options\.yaml$/);
  if (lints) s.add(0.1, ev('config', lints));
  const sdk = declaredVersion(pub.sdk);
  out.push(s.done('dart', 'Dart', 'language', sdk, sdk ? 'declared' : null));
  if (pub.flutterSdk) {
    const f = new Score();
    const dep = c.dep('pub', 'flutter');
    f.add(0.7, dep ? depEv(dep) : ev('manifest', c.pubPath, 'sdk: flutter'));
    if (pub.hasFlutterSection) f.add(0.1, ev('manifest', c.pubPath, 'flutter: section'));
    if (pub.usesMain) f.add(0.1, ev('file', pub.usesMain, 'lib/main.dart'));
    if (pub.platforms.length)
      f.add(
        0.1,
        ev(
          'directory',
          c.root === '.' ? pub.platforms[0]! : `${c.root}/${pub.platforms[0]}`,
          pub.platforms.join(', '),
        ),
      );
    const fl = dep?.resolved ?? null;
    out.push(f.done('flutter', 'Flutter', 'framework', fl, fl ? 'lockfile' : null));
  }
  return out;
}

// ---- capabilities --------------------------------------------------------------------------------------------------------------
const CAPS: [string, DependencyFact['ecosystem'], string[]][] = [
  [
    'authentication',
    'npm',
    [
      'next-auth',
      '@auth/core',
      'passport',
      '@nestjs/passport',
      '@nestjs/jwt',
      'jsonwebtoken',
      '@clerk/nextjs',
      '@supabase/supabase-js',
      '@auth0/nextjs-auth0',
      'firebase',
    ],
  ],
  [
    'authentication',
    'pub',
    ['firebase_auth', 'supabase_flutter', 'google_sign_in', 'flutter_appauth'],
  ],
  [
    'database-access',
    'npm',
    [
      'prisma',
      '@prisma/client',
      'typeorm',
      'drizzle-orm',
      'mongoose',
      'sequelize',
      'pg',
      'mysql2',
      '@nestjs/typeorm',
      '@nestjs/mongoose',
    ],
  ],
  ['database-access', 'pub', ['sqflite', 'drift', 'isar', 'hive', 'floor', 'cloud_firestore']],
  [
    'internationalization',
    'npm',
    ['next-intl', 'i18next', 'react-i18next', 'react-intl', 'vue-i18n', '@angular/localize'],
  ],
  ['internationalization', 'pub', ['flutter_localizations', 'intl', 'easy_localization']],
  [
    'styling-system',
    'npm',
    [
      'tailwindcss',
      'styled-components',
      '@emotion/react',
      '@mui/material',
      '@chakra-ui/react',
      'sass',
      '@radix-ui/react-slot',
      'class-variance-authority',
    ],
  ],
  ['styling-system', 'pub', ['google_fonts', 'flex_color_scheme']],
  [
    'state-management',
    'npm',
    ['redux', '@reduxjs/toolkit', 'zustand', 'jotai', 'recoil', 'mobx', 'pinia', 'vuex'],
  ],
  [
    'state-management',
    'pub',
    [
      'flutter_bloc',
      'bloc',
      'flutter_riverpod',
      'riverpod',
      'hooks_riverpod',
      'provider',
      'get',
      'mobx',
      'flutter_mobx',
    ],
  ],
  [
    'data-fetching',
    'npm',
    [
      '@tanstack/react-query',
      'swr',
      'axios',
      '@apollo/client',
      'graphql',
      '@trpc/client',
      '@trpc/server',
    ],
  ],
  ['data-fetching', 'pub', ['dio', 'http', 'retrofit', 'graphql_flutter', 'chopper']],
  [
    'forms-validation',
    'npm',
    ['react-hook-form', 'formik', 'zod', 'yup', 'class-validator', 'joi'],
  ],
  [
    'forms-validation',
    'pub',
    ['flutter_form_builder', 'form_builder_validators', 'reactive_forms'],
  ],
  [
    'automated-testing',
    'npm',
    [
      'jest',
      'vitest',
      '@playwright/test',
      'cypress',
      'mocha',
      '@testing-library/react',
      'supertest',
    ],
  ],
  [
    'automated-testing',
    'pub',
    ['flutter_test', 'integration_test', 'mocktail', 'mockito', 'bloc_test', 'patrol'],
  ],
  ['api-documentation', 'npm', ['@nestjs/swagger', 'swagger-ui-express', 'swagger-jsdoc']],
  ['real-time', 'npm', ['socket.io', 'socket.io-client', '@nestjs/websockets', 'ws']],
  ['real-time', 'pub', ['web_socket_channel', 'socket_io_client']],
  ['payments', 'npm', ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js']],
  ['payments', 'pub', ['flutter_stripe', 'in_app_purchase']],
  ['charts', 'npm', ['recharts', 'chart.js', 'd3', '@nivo/core', 'apexcharts']],
  ['charts', 'pub', ['fl_chart', 'syncfusion_flutter_charts']],
  ['animation', 'npm', ['framer-motion', 'lottie-react', 'gsap']],
  ['animation', 'pub', ['lottie', 'rive', 'flutter_animate']],
  ['maps', 'npm', ['leaflet', 'mapbox-gl', '@react-google-maps/api']],
  ['maps', 'pub', ['google_maps_flutter', 'flutter_map']],
  [
    'push-notifications',
    'pub',
    ['firebase_messaging', 'flutter_local_notifications', 'onesignal_flutter'],
  ],
  [
    'analytics-monitoring',
    'npm',
    ['@sentry/nextjs', '@sentry/node', '@sentry/react', 'posthog-js', '@vercel/analytics'],
  ],
  ['analytics-monitoring', 'pub', ['firebase_analytics', 'sentry_flutter', 'firebase_crashlytics']],
  ['component-documentation', 'npm', ['storybook', '@storybook/react', '@storybook/nextjs']],
  ['background-jobs', 'npm', ['bullmq', 'bull', '@nestjs/bull', '@nestjs/schedule', 'agenda']],
  ['configuration', 'npm', ['@nestjs/config', 'dotenv', 'env-var', '@t3-oss/env-nextjs']],
];
const TESTISH = new Set(['automated-testing']);
export function dependencyCapabilities(
  deps: (DependencyFact & { path: string })[],
): ManifestCapability[] {
  const by = new Map<string, { conf: number; ev: Evidence[] }>();
  for (const [cap, eco, names] of CAPS) {
    for (const d of deps) {
      if (d.ecosystem !== eco || !names.includes(d.name)) continue;
      const conf =
        d.kind === 'runtime'
          ? 0.85
          : d.kind === 'dev' && TESTISH.has(cap)
            ? 0.8
            : d.kind === 'dev'
              ? 0.55
              : 0.4;
      const cur = by.get(cap) ?? by.set(cap, { conf: 0, ev: [] }).get(cap)!;
      cur.conf = Math.max(cur.conf, conf);
      cur.ev.push(depEv(d));
    }
  }
  return [...by.entries()].map(([name, v]) => ({
    name,
    confidence: round(v.conf),
    evidence: sortEvidence(v.ev, 6),
  }));
}
