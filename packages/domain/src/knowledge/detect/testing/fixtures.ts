import { createHash } from 'node:crypto';
import { languageOf } from '../../archive/filetype';
import type { DetectInput } from '../types';

/** In-memory packages for the detection tests (and the worker tests): a map of path → text, exposed exactly as the ingestion worker exposes a stored snapshot. */
export type Tree = Record<string, string>;
export const asInput = (
  tree: Tree,
  over: { unstored?: string[]; reads?: string[] } = {},
): DetectInput => ({
  files: Object.entries(tree).map(([path, text]) => ({
    path,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    language: languageOf(path),
    stored: !over.unstored?.includes(path),
  })),
  read: async (path, max) => {
    over.reads?.push(path);
    const t = tree[path];
    return t === undefined || Buffer.byteLength(t) > max ? null : t;
  },
});
const j = (v: unknown) => JSON.stringify(v, null, 2);

export const nextApp = (p = ''): Tree => ({
  [`${p}package.json`]: j({
    name: 'modern-saas',
    private: true,
    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    dependencies: {
      next: '^15.0.1',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'next-intl': '^3.0.0',
    },
    devDependencies: { typescript: '^5.4.0', tailwindcss: '^3.4.0', '@types/node': '^22' },
  }),
  [`${p}package-lock.json`]: j({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/next': { version: '15.0.3' },
      'node_modules/react': { version: '19.0.0' },
    },
  }),
  [`${p}next.config.mjs`]: 'export default { reactStrictMode: true };\n',
  [`${p}tsconfig.json`]:
    '{\n // comment\n "compilerOptions": { "strict": true, "target": "ES2022", "module": "esnext", },\n}\n',
  [`${p}tailwind.config.ts`]: 'export default { content: [] };\n',
  [`${p}middleware.ts`]: 'export function middleware() {}\n',
  [`${p}app/layout.tsx`]: 'export default function L({children}){return children}\n',
  [`${p}app/page.tsx`]: 'export default function P(){return null}\n',
  [`${p}app/(marketing)/about/page.tsx`]: 'export default function A(){return null}\n',
  [`${p}app/[locale]/dashboard/page.tsx`]: 'export default function D(){return null}\n',
  [`${p}app/@modal/login/page.tsx`]: 'export default function M(){return null}\n',
  [`${p}app/blog/[...slug]/page.tsx`]: 'export default function B(){return null}\n',
  [`${p}app/api/users/route.ts`]:
    'export async function GET() {}\nexport async function POST() {}\n',
});
export const nextPages = (): Tree => ({
  'package.json': j({ name: 'old-next', dependencies: { next: '13.5.6', react: '^18' } }),
  'pages/_app.tsx': 'x',
  'pages/_document.tsx': 'x',
  'pages/index.tsx': 'x',
  'pages/blog/[slug].tsx': 'x',
  'pages/blog/index.tsx': 'x',
  'pages/api/hello.ts': 'x',
});
export const nestApp = (): Tree => ({
  'package.json': j({
    name: 'property-api',
    scripts: { build: 'nest build', 'start:dev': 'nest start --watch' },
    engines: { node: '>=20' },
    dependencies: {
      '@nestjs/core': '^10.3.0',
      '@nestjs/common': '^10.3.0',
      '@nestjs/swagger': '^7',
      '@nestjs/jwt': '^10',
      typeorm: '^0.3.20',
    },
  }),
  'nest-cli.json': j({ collection: '@nestjs/schematics', sourceRoot: 'src' }),
  Dockerfile: 'FROM node:20-alpine AS build\nFROM node:20-alpine\n',
  'src/main.ts':
    "import { NestFactory } from '@nestjs/core';\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix('api');\n  SwaggerModule.setup('docs', app, doc);\n}\n",
  'src/app.module.ts': '@Module({\n  imports: [],\n})\nexport class AppModule {}\n',
  'src/users/users.module.ts':
    '@Module({ controllers: [UsersController] })\nexport class UsersModule {}\n',
  'src/users/users.controller.ts':
    "@UseGuards(JwtGuard)\n@Controller('users')\nexport class UsersController {\n  @Get()\n  list() {}\n  @Get(':id')\n  one() {}\n  @Post()\n  create() {}\n  @Delete(':id/avatar')\n  rm() {}\n}\n",
  'src/users/users.service.spec.ts': "@Controller('ignored')\nexport class X {}\n",
});
export const flutterApp = (): Tree => ({
  'pubspec.yaml': [
    'name: gym_app',
    'description: A gym app',
    'version: 1.0.0+1',
    'environment:',
    "  sdk: '>=3.3.0 <4.0.0'",
    '  flutter: ">=3.19.0"',
    'dependencies:',
    '  flutter:',
    '    sdk: flutter',
    '  go_router: ^13.2.0',
    '  flutter_bloc: ^8.1.5',
    '  provider: ^6.1.2',
    '  intl: ^0.19.0',
    'dev_dependencies:',
    '  flutter_test:',
    '    sdk: flutter',
    'flutter:',
    '  uses-material-design: true',
    '  assets:',
    '    - assets/logo.png',
    '    - assets/hero.png',
    '',
  ].join('\n'),
  'pubspec.lock': [
    'packages:',
    '  go_router:',
    '    dependency: "direct main"',
    '    source: hosted',
    '    version: "13.2.4"',
    '  flutter_bloc:',
    '    dependency: "direct main"',
    '    version: "8.1.6"',
    '',
  ].join('\n'),
  'analysis_options.yaml': 'include: package:flutter_lints/flutter.yaml\n',
  'lib/main.dart': 'void main() {\n  runApp(const App());\n}\n',
  'lib/router.dart':
    "final router = GoRouter(routes: [\n  GoRoute(\n    path: '/',\n    builder: (c, s) => const HomeScreen(),\n  ),\n  GoRoute(\n    name: 'workout',\n    path: '/workouts/:id',\n    builder: (c, s) => const WorkoutPage(),\n  ),\n]);\n",
  'lib/screens/home_screen.dart': 'class HomeScreen extends StatelessWidget {\n}\n',
  'lib/screens/workout_page.dart':
    'class WorkoutPage extends StatefulWidget {\n}\nclass _WorkoutState extends State<WorkoutPage> {}\n',
  'lib/widgets/button.dart': 'class PrimaryButton extends StatelessWidget {}\n',
  'android/app/build.gradle': 'x',
  'ios/Runner/Info.plist': 'x',
  'web/index.html': '<html></html>',
});
export const dartCli = (): Tree => ({
  'pubspec.yaml': [
    'name: tool',
    'environment:',
    '  sdk: ^3.2.0',
    'dependencies:',
    '  args: ^2.4.0',
    '',
  ].join('\n'),
  'bin/tool.dart': 'void main() {}\n',
  'lib/tool.dart': 'class Tool {}\n',
});
export const pnpmFullstack = (): Tree => ({
  'package.json': j({
    name: 'property-suite',
    private: true,
    packageManager: 'pnpm@9.1.0',
    devDependencies: { turbo: '^2' },
  }),
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  'turbo.json': '{}',
  'pnpm-lock.yaml': [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    devDependencies:',
    '      turbo:',
    '        specifier: ^2',
    '        version: 2.0.1',
    '  apps/web:',
    '    dependencies:',
    '      next:',
    '        specifier: ^15.0.0',
    '        version: 15.0.2(react@19.0.0)',
    '  apps/api:',
    '    dependencies:',
    "      '@nestjs/core':",
    '        specifier: ^10',
    '        version: 10.4.1',
    '',
  ].join('\n'),
  ...Object.fromEntries(
    Object.entries(nextApp('apps/web/')).filter(([k]) => !k.endsWith('package-lock.json')),
  ),
  'apps/api/package.json': j({
    name: '@suite/api',
    dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10' },
  }),
  'apps/api/nest-cli.json': '{}',
  'apps/api/src/main.ts': 'const app = await NestFactory.create(AppModule);\n',
  'apps/api/src/app.controller.ts':
    "@Controller()\nexport class AppController {\n  @Get('health')\n  h() {}\n}\n",
  'packages/ui/package.json': j({
    name: '@suite/ui',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    peerDependencies: { react: '^19' },
  }),
  'packages/ui/src/index.ts': 'export {};\n',
});
export const reactVite = (): Tree => ({
  'package.json': j({
    name: 'spa',
    scripts: { dev: 'vite', build: 'vite build' },
    dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' },
    devDependencies: { vite: '^5', typescript: '^5' },
  }),
  'vite.config.ts': 'export default {};\n',
  'index.html': '<div id="root"></div>',
  'src/main.tsx': 'x',
});
export const expressApi = (): Tree => ({
  'package.json': j({
    name: 'api',
    main: 'server.js',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.19.0' },
  }),
  'yarn.lock': ['express@^4.19.0:', '  version "4.19.2"', ''].join('\n'),
  'server.js': "require('express')();\n",
});
export const djangoApp = (): Tree => ({
  'requirements.txt': 'Django==5.0.3\npsycopg2>=2.9\n',
  'manage.py': '#!/usr/bin/env python\n',
  'app/settings.py': 'x',
});
export const laravelApp = (): Tree => ({
  'composer.json': j({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }),
  artisan: '#!/usr/bin/env php\n',
  'routes/web.php': '<?php',
});

// ---- negative and ambiguous ---------------------------------------------------------------------------------------------------------
export const readmeOnly = (): Tree => ({
  'package.json': j({ name: 'docs-site', version: '1.0.0' }),
  'README.md':
    '# Built with Next.js, React, NestJS and Flutter\nnpm install next react @nestjs/core\n',
  'docs/guide.md': 'We use Next.js and Flutter. pubspec.yaml sdk: flutter\n',
});
export const nextDevOnly = (): Tree => ({
  'package.json': j({ name: 'x', devDependencies: { next: '^14' } }),
});
export const nextNoRoutes = (): Tree => ({
  'package.json': j({ name: 'x', dependencies: { next: '^14', react: '^18' } }),
  'src/index.ts': 'x',
});
export const conflicting = (): Tree => ({
  'package.json': j({ name: 'x', dependencies: { next: '^14', vue: '^3', react: '^18' } }),
  'app/page.tsx': 'x',
});
export const twoLocks = (): Tree => ({
  'package.json': j({ name: 'x', dependencies: { react: '^18', 'react-dom': '^18' } }),
  'package-lock.json': '{}',
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
});
export const flutterLayoutOnly = (): Tree => ({
  'lib/main.dart': 'void main() {}\n',
  'android/app/build.gradle': 'x',
  'ios/Runner/Info.plist': 'x',
  'web/index.html': 'x',
});
export const dartFlutterLayoutNoSdk = (): Tree => ({
  ...dartCli(),
  'lib/main.dart': 'void main() {}\n',
  'android/app/build.gradle': 'x',
  'ios/Runner/Info.plist': 'x',
});
export const vendoredExamples = (): Tree => ({
  'package.json': j({ name: 'ui-kit', main: 'dist/index.js', types: 'dist/index.d.ts' }),
  'src/index.ts': 'export {};\n',
  ...Object.fromEntries(
    Object.entries(nextApp('examples/next-demo/')).filter(([k]) => !k.endsWith('lock.json')),
  ),
});
export const onlyExamples = (): Tree =>
  Object.fromEntries(
    Object.entries(nextApp('examples/demo/')).filter(([k]) => !k.endsWith('lock.json')),
  );
export const emptyPackageJson = (): Tree => ({ 'package.json': '{}' });
export const noManifest = (): Tree => ({ 'src/app.py': 'print(1)\n', 'README.md': '# hi\n' });
