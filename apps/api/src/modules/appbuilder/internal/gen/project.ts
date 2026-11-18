import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf } from '../core';
import type { AppSpec } from '../spec/app-spec';
import { buildMeta, renderMetaTs } from './meta';
import { generateOpenApi } from './openapi';
import { rbacMarkdown } from './rbac';
import { initialMigration, type GeneratedMigration } from './sql';
import { generateTests } from './tests-gen';

export const SCAFFOLD_VERSION = 'webapp-node-pg/1';
/** Pinned toolchain of the generated web app (recorded in the report): Node 22 LTS with type stripping, TypeScript 5.9, pg 8. Versions are RANGES here; the lockfile pins them (created in the sandbox through the package mirror). */
export const TOOLCHAIN = {
  node: '>=22.15',
  typescript: '~5.9.3',
  pg: '^8.13.0',
  typesNode: '^22.10.0',
  typesPg: '^8.11.10',
} as const;

/** Static runtime of the scaffold: apps/api/templates/webapp-runtime (the same relative path from `src/` and from the compiled `dist/`). */
const TEMPLATE_DIR = join(__dirname, '../../../../../templates/webapp-runtime');
let cache: Record<string, string> | null = null;
export function runtimeFiles(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${f}/`);
      else out[`${prefix}${f}`] = readFileSync(p, 'utf8');
    }
  };
  walk(TEMPLATE_DIR, '');
  cache = out;
  return out;
}

export interface GeneratedProject {
  files: Map<string, string>;
  migrations: GeneratedMigration[];
  openapi: Record<string, unknown>;
  /** sha256 of the canonical spec: quoted by every artifact derived from it. */
  specHash: string;
}

const migrationFile = (m: GeneratedMigration) =>
  `db/migrations/${String(m.version).padStart(4, '0')}_${m.name}`;

export function packageJson(spec: AppSpec): Record<string, unknown> {
  return {
    name: spec.slug,
    version: '1.0.0',
    private: true,
    type: 'module',
    description: spec.description,
    engines: { node: TOOLCHAIN.node },
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts',
      build: 'tsc -p tsconfig.build.json',
      start: 'node --experimental-strip-types src/server.ts',
      migrate: 'node --experimental-strip-types src/migrate.ts',
      seed: 'node --experimental-strip-types src/seed.ts',
    },
    dependencies: { pg: TOOLCHAIN.pg },
    devDependencies: {
      typescript: TOOLCHAIN.typescript,
      '@types/node': TOOLCHAIN.typesNode,
      '@types/pg': TOOLCHAIN.typesPg,
    },
  };
}

/**
 * Assembles the end-to-end project (S44.2) from an APPROVED spec plus extra migrations: static runtime + metadata + SQL + OpenAPI + RBAC doc + tests + deployment manifest.
 * Deterministic: the same spec gives the same bytes (no timestamps), which the export/rebuild and the evaluation harness rely on.
 */
export function generateProject(
  spec: AppSpec,
  o: { extraMigrations?: GeneratedMigration[] } = {},
): GeneratedProject {
  const files = new Map<string, string>();
  const meta = buildMeta(spec);
  const openapi = generateOpenApi(spec);
  const migrations = [initialMigration(spec), ...(o.extraMigrations ?? [])];
  const specHash = hashOf(spec);
  for (const [path, content] of Object.entries(runtimeFiles()))
    files.set(path.startsWith('src/') || path.startsWith('public/') ? path : path, content);
  files.set('src/meta.ts', renderMetaTs(meta));
  files.set('public/meta.json', JSON.stringify(meta));
  for (const m of migrations) {
    files.set(`${migrationFile(m)}.sql`, m.up + '\n');
    files.set(`${migrationFile(m)}.down.sql`, m.down + '\n');
  }
  files.set('openapi.json', JSON.stringify(openapi, null, 2) + '\n');
  files.set('docs/RBAC.md', rbacMarkdown(spec));
  for (const [p, c] of Object.entries(generateTests(spec))) files.set(p, c);
  files.set('package.json', JSON.stringify(packageJson(spec), null, 2) + '\n');
  files.set(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src/**/*.ts', 'tests/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  files.set(
    'tsconfig.build.json',
    JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: {
          noEmit: false,
          outDir: 'dist',
          rewriteRelativeImportExtensions: true,
          allowImportingTsExtensions: false,
          erasableSyntaxOnly: false,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  files.set('.gitignore', 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n');
  files.set(
    '.env.example',
    '# copy to .env; never commit real values\nPORT=8080\nSTORE=pg\nDATABASE_URL=postgres://app_user:<password>@localhost:5432/app\nSESSION_SECRET=change-me-to-a-random-string-of-at-least-32-characters\nSEED_ADMIN_EMAIL=admin@example.test\nSEED_ADMIN_PASSWORD=change-me-please-1\n# optional transactional email endpoint for notifications\nNOTIFY_URL=\nNOTIFY_TOKEN=\n',
  );
  files.set(
    'nuzm.app.json',
    JSON.stringify(
      {
        scaffold: SCAFFOLD_VERSION,
        specHash,
        runtime: { node: TOOLCHAIN.node },
        // the commands the Nuzm test runner executes in the sandbox (no shell: argv arrays)
        commands: {
          install: ['npm', 'ci', '--ignore-scripts'],
          lock: ['npm', 'install', '--package-lock-only', '--ignore-scripts'],
          typecheck: ['npx', 'tsc', '--noEmit'],
          unit: [
            'node',
            '--experimental-strip-types',
            '--test',
            '--test-concurrency=1',
            '--test-reporter=junit',
            'tests/*.test.ts',
          ],
          build: ['npx', 'tsc', '-p', 'tsconfig.build.json'],
        },
        deploy: {
          start: ['node', '--experimental-strip-types', 'src/server.ts'],
          migrate: ['node', '--experimental-strip-types', 'src/migrate.ts'],
          healthPath: '/health',
          env: ['DATABASE_URL', 'SESSION_SECRET', 'PORT'],
        },
        lockfile: 'required',
      },
      null,
      2,
    ) + '\n',
  );
  files.set('README.md', readme(spec));
  return { files, migrations, openapi, specHash };
}

function readme(spec: AppSpec): string {
  return `# ${spec.name}

${spec.description}

Generated by the Nuzm app builder from an approved application spec. The source is yours: export it, build it and run it anywhere Node 22 and PostgreSQL run.

## Run

\`\`\`bash
npm ci --ignore-scripts
export DATABASE_URL=postgres://app_user:<password>@localhost:5432/app SESSION_SECRET=$(openssl rand -hex 32)
npm run migrate
SEED_ADMIN_EMAIL=admin@example.test SEED_ADMIN_PASSWORD=change-me-please-1 npm run seed
npm start
\`\`\`

## Check

\`\`\`bash
npm run typecheck
npm test
\`\`\`

## Layout

- \`src/\` API (generic CRUD engine driven by \`src/meta.ts\`), authentication, CSV import/export, audit trail
- \`public/\` Arabic (RTL) and English single-page front end, keyboard accessible
- \`db/migrations/\` versioned SQL with a \`.down.sql\` for every migration
- \`openapi.json\` the REST contract; \`docs/RBAC.md\` roles and the row-level rule
- \`tests/\` contract, access-control and validation tests (synthetic data only)

## Notes

- A lockfile is required before deployment; create it with \`npm install --package-lock-only --ignore-scripts\`.
- Install scripts of dependencies are disabled (\`--ignore-scripts\`).
- No secret is stored in the repository: configuration comes from the environment (see \`.env.example\`).
`;
}
