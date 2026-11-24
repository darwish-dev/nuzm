import type { Bilingual, ModuleSpec, StackOption, TaskKind } from './types';

/** Helpers that keep the profile tables readable. A module's acceptance criteria are written as [English, Arabic] pairs. */
export const b = (en: string, ar: string): Bilingual => ({ en, ar });
type Acc = readonly [string, string][];
export const mod = (
  id: string,
  title: [string, string],
  kind: TaskKind,
  dependsOn: readonly string[],
  files: readonly string[],
  acceptance: Acc,
  feature: string | null,
  size: 1 | 2 | 3 | 4 | 5,
  approval?: string,
): ModuleSpec => ({
  id,
  title: b(...title),
  kind,
  dependsOn,
  files,
  acceptance: acceptance.map(([en, ar]) => b(en, ar)),
  feature,
  size,
  ...(approval ? { approval } : {}),
});

export const STACK_NEXT_NEST: StackOption = {
  id: 'next-nest-pg',
  title: b('Next.js + NestJS + PostgreSQL', 'Next.js + NestJS + PostgreSQL'),
  parts: ['TypeScript', 'Next.js', 'NestJS', 'PostgreSQL'],
  keywords: ['next', 'nextjs', 'react', 'nestjs', 'typescript', 'postgres', 'postgresql'],
  family: 'node-web',
};
export const STACK_NEXT_ONLY: StackOption = {
  id: 'next-static',
  title: b('Next.js (static export)', 'Next.js (تصدير ثابت)'),
  parts: ['TypeScript', 'Next.js'],
  keywords: ['next', 'nextjs', 'react', 'static'],
  family: 'static',
};
export const STACK_HTML: StackOption = {
  id: 'html-css',
  title: b('Plain HTML + CSS', 'HTML + CSS بسيط'),
  parts: ['HTML', 'CSS'],
  keywords: ['html', 'css', 'plain'],
  family: 'static',
};
export const STACK_NEST_API: StackOption = {
  id: 'nest-pg',
  title: b('NestJS + PostgreSQL (OpenAPI)', 'NestJS + PostgreSQL (OpenAPI)'),
  parts: ['TypeScript', 'NestJS', 'PostgreSQL', 'OpenAPI'],
  keywords: ['nest', 'nestjs', 'typescript', 'postgres', 'postgresql', 'openapi'],
  family: 'node-api',
};
export const STACK_FLUTTER: StackOption = {
  id: 'flutter',
  title: b('Flutter (Dart)', 'Flutter (Dart)'),
  parts: ['Dart', 'Flutter'],
  keywords: ['flutter', 'dart'],
  family: 'flutter',
};
export const STACK_SQL: StackOption = {
  id: 'postgres-sql',
  title: b('PostgreSQL migrations', 'ترحيلات PostgreSQL'),
  parts: ['PostgreSQL', 'SQL'],
  keywords: ['postgres', 'postgresql', 'sql'],
  family: 'sql',
};

/** Stack names a customer may ask for that Nuzm's templates do NOT generate: the plan uses the default and says so (never a silent swap). */
export const UNSUPPORTED_STACKS: readonly { name: string; keywords: readonly string[] }[] = [
  { name: 'WordPress', keywords: ['wordpress', 'woocommerce'] },
  { name: 'Laravel / PHP', keywords: ['laravel', 'php'] },
  { name: 'Django / Python', keywords: ['django', 'flask', 'fastapi'] },
  { name: 'Ruby on Rails', keywords: ['rails', 'ruby'] },
  { name: 'Vue / Angular', keywords: ['vue', 'angular', 'nuxt'] },
  { name: 'Java / Spring', keywords: ['spring boot', 'java'] },
  { name: '.NET', keywords: ['asp.net', 'dotnet', '.net'] },
  { name: 'React Native', keywords: ['react native', 'expo'] },
];

// ── shared module files per family ──
export const WEB_SCAFFOLD = ['package.json', 'tsconfig.json', 'next.config.mjs', 'app/layout.tsx', 'app/page.tsx', 'README.md'];
export const API_SCAFFOLD = ['package.json', 'tsconfig.json', 'src/main.ts', 'src/app.module.ts', 'README.md'];
