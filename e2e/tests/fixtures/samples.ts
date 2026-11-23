import { filler, zip, type ZipEntry } from './zip';

/**
 * Safe sample projects for the knowledge-library upload tests. They are small text trees that look like the real thing (so the later analyzers have something
 * true to read) and contain nothing that runs: no lifecycle scripts, no binaries, no secrets (only placeholders), plain MIT licences.
 */
const MIT = `MIT License\n\nCopyright (c) 2026 Nuzm sample\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.\n`;
const readme = (title: string, body: string) =>
  `# ${title}\n\n${body}\n\nThis is a test fixture of the Nuzm AI Intelligence Center. It is never installed, built or run.\n`;

const nextjs = (): ZipEntry[] => [
  {
    path: 'modern-saas/package.json',
    data: JSON.stringify(
      {
        name: 'modern-saas',
        version: '1.0.0',
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: {
          next: '15.0.0',
          react: '19.0.0',
          'react-dom': '19.0.0',
          tailwindcss: '4.0.0',
        },
        devDependencies: { typescript: '5.9.3' },
      },
      null,
      2,
    ),
  },
  { path: 'modern-saas/next.config.mjs', data: 'export default { reactStrictMode: true };\n' },
  {
    path: 'modern-saas/tsconfig.json',
    data: JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          jsx: 'preserve',
          module: 'esnext',
          moduleResolution: 'bundler',
        },
      },
      null,
      2,
    ),
  },
  {
    path: 'modern-saas/tailwind.config.ts',
    data: "export default { theme: { extend: { colors: { brand: '#0f766e', primary: 'hsl(var(--primary))' } } } };\n",
  },
  {
    path: 'modern-saas/app/globals.css',
    data: ':root {\n  --background: 0 0% 100%;\n  --foreground: 222 47% 11%;\n  --primary: 221 83% 53%;\n  --primary-foreground: 210 40% 98%;\n  --border: 214 32% 91%;\n  --radius: 0.5rem;\n  --font-sans: Cairo, sans-serif;\n}\n.dark {\n  --background: 222 47% 11%;\n  --foreground: 210 40% 98%;\n}\nbody { background: hsl(var(--background)); color: hsl(var(--foreground)); direction: rtl; border-color: hsl(var(--border)); }\n',
  },
  {
    path: 'modern-saas/app/layout.tsx',
    data: 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n',
  },
  {
    path: 'modern-saas/app/page.tsx',
    data: "import { Sidebar } from '../components/Sidebar';\nexport default function Home() {\n  return <main><Sidebar /><h1>Dashboard</h1></main>;\n}\n",
  },
  {
    path: 'modern-saas/app/dashboard/page.tsx',
    data: 'export default function Dashboard() {\n  return <section><h2>Metrics</h2></section>;\n}\n',
  },
  {
    path: 'modern-saas/components/Sidebar.tsx',
    data: 'export function Sidebar() {\n  return <nav aria-label="Main"><a href="/dashboard">Dashboard</a></nav>;\n}\n',
  },
  { path: 'modern-saas/.env.example', data: 'API_URL=https://api.example.test\n' },
  {
    path: 'modern-saas/README.md',
    data: readme('Modern SaaS (Next.js)', 'A sidebar dashboard theme.'),
  },
  { path: 'modern-saas/LICENSE', data: MIT },
];

const flutter = (): ZipEntry[] => [
  {
    path: 'gym_app/pubspec.yaml',
    data: 'name: gym_app\ndescription: Gym management starter.\nversion: 1.0.0+1\nenvironment:\n  sdk: ">=3.5.0 <4.0.0"\n  flutter: ">=3.24.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_bloc: ^8.1.6\n  go_router: ^14.2.0\nflutter:\n  uses-material-design: true\n',
  },
  { path: 'gym_app/analysis_options.yaml', data: 'include: package:flutter_lints/flutter.yaml\n' },
  {
    path: 'gym_app/lib/main.dart',
    data: "import 'package:flutter/material.dart';\nimport 'app/router.dart';\n\nvoid main() => runApp(const GymApp());\n\nclass GymApp extends StatelessWidget {\n  const GymApp({super.key});\n  @override\n  Widget build(BuildContext context) => MaterialApp.router(routerConfig: router, theme: ThemeData(useMaterial3: true));\n}\n",
  },
  {
    path: 'gym_app/lib/app/router.dart',
    data: "import 'package:go_router/go_router.dart';\nimport '../features/home/home_screen.dart';\n\nfinal router = GoRouter(routes: [GoRoute(path: '/', builder: (c, s) => const HomeScreen())]);\n",
  },
  {
    path: 'gym_app/lib/features/home/home_screen.dart',
    data: "import 'package:flutter/material.dart';\n\nclass HomeScreen extends StatelessWidget {\n  const HomeScreen({super.key});\n  @override\n  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Members')));\n}\n",
  },
  {
    path: 'gym_app/lib/app/theme.dart',
    data: "import 'package:flutter/material.dart';\n\nclass AppColors {\n  static const Color primary = Color(0xFF1E88E5);\n  static const Color background = Color(0xFFFAFAFA);\n}\n\nfinal lightTheme = ThemeData(useMaterial3: true, fontFamily: 'Cairo');\n",
  },
  { path: 'gym_app/android/app/build.gradle', data: "android { namespace 'test.gym' }\n" },
  { path: 'gym_app/README.md', data: readme('Gym App (Flutter)', 'A Bloc + go_router starter.') },
  { path: 'gym_app/LICENSE', data: MIT },
];

const fullstack = (): ZipEntry[] => [
  {
    path: 'property-suite/package.json',
    data: JSON.stringify(
      { name: 'property-suite', private: true, workspaces: ['apps/*'] },
      null,
      2,
    ),
  },
  { path: 'property-suite/pnpm-workspace.yaml', data: "packages:\n  - 'apps/*'\n" },
  {
    path: 'property-suite/apps/web/package.json',
    data: JSON.stringify(
      {
        name: '@suite/web',
        version: '1.0.0',
        scripts: { dev: 'next dev', build: 'next build' },
        dependencies: { next: '15.0.0', react: '19.0.0' },
      },
      null,
      2,
    ),
  },
  {
    path: 'property-suite/apps/web/app/page.tsx',
    data: 'export default function Page() {\n  return <h1>Properties</h1>;\n}\n',
  },
  {
    path: 'property-suite/apps/api/package.json',
    data: JSON.stringify(
      {
        name: '@suite/api',
        version: '1.0.0',
        scripts: { start: 'nest start', build: 'nest build' },
        dependencies: { '@nestjs/common': '11.0.0', '@nestjs/core': '11.0.0', pg: '8.13.0' },
      },
      null,
      2,
    ),
  },
  {
    path: 'property-suite/apps/api/src/main.ts',
    data: "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nNestFactory.create(AppModule).then((a) => a.listen(4000));\n",
  },
  {
    path: 'property-suite/apps/api/src/app.module.ts',
    data: "import { Module } from '@nestjs/common';\nimport { PropertiesController } from './properties.controller';\n@Module({ controllers: [PropertiesController] })\nexport class AppModule {}\n",
  },
  {
    path: 'property-suite/apps/api/src/properties.controller.ts',
    data: "import { Controller, Get } from '@nestjs/common';\n@Controller('properties')\nexport class PropertiesController {\n  @Get()\n  list() {\n    return [];\n  }\n}\n",
  },
  {
    path: 'property-suite/db/migrations/0001_properties.sql',
    data: 'CREATE TABLE properties (id uuid PRIMARY KEY, org_id uuid NOT NULL, name text NOT NULL);\nALTER TABLE properties ENABLE ROW LEVEL SECURITY;\n',
  },
  {
    path: 'property-suite/README.md',
    data: readme('Property Suite (Next.js + NestJS)', 'A multi-tenant full-stack starter.'),
  },
  { path: 'property-suite/LICENSE', data: MIT },
];

export interface Sample {
  key: 'nextjs' | 'flutter' | 'fullstack';
  filename: string;
  name: string;
  resourceType: string;
  platform: string;
  frameworks: string[];
  languages: string[];
  category: string;
  tags: string[];
  license: string;
  build: (opts?: { padBytes?: number }) => Buffer;
  /** The files of the package, for tests that add a file of their own (S-K2a ingestion). */
  entries: () => ZipEntry[];
}
const pad = (entries: ZipEntry[], padBytes: number | undefined, dir: string): ZipEntry[] =>
  padBytes
    ? [...entries, { path: `${dir}/assets/sample-media.bin`, data: filler(padBytes) }]
    : entries;

export const SAMPLES: Sample[] = [
  {
    key: 'nextjs',
    filename: 'modern-saas-nextjs.zip',
    name: 'Modern SaaS',
    resourceType: 'THEME',
    platform: 'WEB',
    frameworks: ['nextjs', 'tailwind'],
    languages: ['typescript'],
    category: 'dashboard',
    tags: ['saas', 'sidebar'],
    license: 'MIT',
    entries: nextjs,
    build: (o) => zip(pad(nextjs(), o?.padBytes, 'modern-saas')),
  },
  {
    key: 'flutter',
    filename: 'gym-app-flutter.zip',
    name: 'Gym App',
    resourceType: 'STARTER_KIT',
    platform: 'MOBILE',
    frameworks: ['flutter'],
    languages: ['dart'],
    category: 'fitness',
    tags: ['mobile', 'bloc'],
    license: 'MIT',
    entries: flutter,
    build: (o) => zip(pad(flutter(), o?.padBytes, 'gym_app')),
  },
  {
    key: 'fullstack',
    filename: 'property-suite-fullstack.zip',
    name: 'Property Suite',
    resourceType: 'PROJECT',
    platform: 'FULL_STACK',
    frameworks: ['nextjs', 'nestjs'],
    languages: ['typescript', 'sql'],
    category: 'real-estate',
    tags: ['saas', 'multi-tenant'],
    license: 'MIT',
    entries: fullstack,
    build: (o) => zip(pad(fullstack(), o?.padBytes, 'property-suite')),
  },
];
