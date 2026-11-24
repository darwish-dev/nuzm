import { json, task } from './task-builder';
import type { FixtureFile, GoldenTask } from './types';

/** Extended golden tasks, part 3: backend APIs, database architecture, authentication, multi-file refactoring, bug fixing, security remediation, build and deployment planning. Synthetic. */
const L = (...lines: string[]) => `${lines.join('\n')}\n`;
const f = (path: string, content: string): FixtureFile => ({ path, content });

const HEALTH = L(
  'export interface HealthResponse {',
  "  status: 'ok';",
  '}',
  '',
  'export function health(): HealthResponse {',
  "  return { status: 'ok' };",
  '}',
);
const OPENAPI = (extra: Record<string, unknown> = {}) =>
  json({
    openapi: '3.1.0',
    info: { title: 'Demo', version: '1.0.0' },
    paths: { '/health': { get: { responses: { '200': { description: 'ok' } } } }, ...extra },
  });
const BACKEND = [f('src/api/health.ts', HEALTH), f('openapi.json', OPENAPI())];

const SCHEMA = L(
  'CREATE TABLE customers (',
  '  id uuid PRIMARY KEY,',
  '  name text NOT NULL',
  ');',
  '',
  'CREATE TABLE orders (',
  '  id uuid PRIMARY KEY,',
  '  customer_id uuid NOT NULL REFERENCES customers (id),',
  '  total numeric(10,2) NOT NULL',
  ');',
);
const DB = [f('db/schema.sql', SCHEMA)];

const SESSION = L(
  'export interface Session {',
  '  userId: string;',
  '  expiresAt: number;',
  '}',
  '',
  'export function isExpired(s: Session, now: number): boolean {',
  '  return s.expiresAt < now;',
  '}',
);
const ROLES = L("export type Role = 'admin' | 'member';");
const AUTH = [f('src/auth/session.ts', SESSION), f('src/auth/roles.ts', ROLES)];

const FORMAT = L(
  'export function fullName(first: string, last: string): string {',
  "  return first + ' ' + last;",
  '}',
);
const CARD = L(
  "import { fullName } from './format';",
  '',
  'export const cardTitle = (first: string, last: string) => fullName(first, last).toUpperCase();',
);
const EMAIL = L(
  'export function emailLabel(first: string, last: string, email: string): string {',
  "  return first + ' ' + last + ' <' + email + '>';",
  '}',
);
const REFAC = [
  f('src/user/format.ts', FORMAT),
  f('src/user/card.ts', CARD),
  f('src/user/email.ts', EMAIL),
];

const PKG = (scripts: Record<string, string>) => json({ name: 'demo', version: '1.0.0', scripts });
const BUILD = [
  f('package.json', PKG({ build: 'tsc -p tsconfig.json', test: 'vitest run' })),
  f('docs/README.md', '# Demo\n'),
];

export const ENGINEERING_TASKS: readonly GoldenTask[] = [
  // ---- backend APIs
  task({
    id: 'api-01-version-endpoint',
    category: 'backend-api',
    locale: 'en',
    title: 'A version endpoint and its contract',
    prompt:
      'Add GET /version: a version() handler in src/api/version.ts returning { version: "1.0.0" }, and document the path in openapi.json (contract first).',
    fixture: BACKEND,
    mustCall: ['read_file'],
    checks: [
      { type: 'file_exists', path: 'src/api/version.ts' },
      { type: 'contains', path: 'src/api/version.ts', text: "version: '1.0.0'" },
      { type: 'json_valid', path: 'openapi.json' },
      { type: 'contains', path: 'openapi.json', text: '"/version"' },
      { type: 'contains', path: 'openapi.json', text: '"/health"' },
    ],
    solution: [
      {
        path: 'src/api/version.ts',
        content: L(
          'export function version(): { version: string } {',
          "  return { version: '1.0.0' };",
          '}',
        ),
      },
      {
        path: 'openapi.json',
        content: OPENAPI({
          '/version': { get: { responses: { '200': { description: 'version' } } } },
        }),
      },
    ],
  }),
  task({
    id: 'api-02-pagination',
    category: 'backend-api',
    locale: 'en',
    title: 'Bounded pagination',
    prompt:
      'Create src/api/pagination.ts with paginate(items, page, pageSize): pages start at 1 and pageSize is capped at 100.',
    fixture: BACKEND,
    checks: [
      { type: 'file_exists', path: 'src/api/pagination.ts' },
      { type: 'contains', path: 'src/api/pagination.ts', text: 'export function paginate' },
      { type: 'contains', path: 'src/api/pagination.ts', text: 'Math.min(' },
      { type: 'contains', path: 'src/api/pagination.ts', text: '100' },
    ],
    solution: [
      {
        path: 'src/api/pagination.ts',
        content: L(
          'export function paginate<T>(items: T[], page: number, pageSize: number): T[] {',
          '  const size = Math.min(Math.max(1, pageSize), 100);',
          '  const start = (Math.max(1, page) - 1) * size;',
          '  return items.slice(start, start + size);',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'api-03-error-shape-ar',
    category: 'backend-api',
    locale: 'ar',
    title: 'صنف موحّد للأخطاء',
    prompt:
      'أنشئ src/api/errors.ts يحتوي على الصنف ApiError الذي يرث من Error ويحمل code (نص) وstatus (رقم).',
    fixture: BACKEND,
    checks: [
      { type: 'contains', path: 'src/api/errors.ts', text: 'export class ApiError extends Error' },
      { type: 'matches', path: 'src/api/errors.ts', pattern: String.raw`code: string` },
      { type: 'matches', path: 'src/api/errors.ts', pattern: String.raw`status: number` },
    ],
    solution: [
      {
        path: 'src/api/errors.ts',
        content: L(
          'export class ApiError extends Error {',
          '  constructor(',
          '    readonly code: string,',
          '    readonly status: number,',
          '    message: string,',
          '  ) {',
          '    super(message);',
          "    this.name = 'ApiError';",
          '  }',
          '}',
        ),
      },
    ],
  }),

  // ---- database architecture
  task({
    id: 'db-01-tenant-table',
    category: 'database-architecture',
    locale: 'en',
    title: 'A tenant-scoped table',
    prompt:
      'Add an invoices table to db/schema.sql: uuid primary key, org_id uuid NOT NULL, a foreign key to customers, and row-level security enabled.',
    fixture: DB,
    checks: [
      { type: 'matches', path: 'db/schema.sql', pattern: String.raw`CREATE TABLE invoices` },
      { type: 'matches', path: 'db/schema.sql', pattern: String.raw`org_id uuid NOT NULL` },
      { type: 'matches', path: 'db/schema.sql', pattern: String.raw`REFERENCES customers` },
      {
        type: 'matches',
        path: 'db/schema.sql',
        pattern: String.raw`ALTER TABLE invoices ENABLE ROW LEVEL SECURITY`,
      },
    ],
    solution: [
      {
        path: 'db/schema.sql',
        content: `${SCHEMA}\nCREATE TABLE invoices (\n  id uuid PRIMARY KEY,\n  org_id uuid NOT NULL,\n  customer_id uuid NOT NULL REFERENCES customers (id)\n);\n\nALTER TABLE invoices ENABLE ROW LEVEL SECURITY;\n`,
      },
    ],
  }),
  task({
    id: 'db-02-index',
    category: 'database-architecture',
    locale: 'en',
    title: 'Index the foreign key',
    prompt:
      'Queries join orders to customers constantly. Add an index on orders (customer_id) named orders_customer_id_idx.',
    fixture: DB,
    checks: [
      {
        type: 'matches',
        path: 'db/schema.sql',
        pattern: String.raw`CREATE INDEX orders_customer_id_idx ON orders \(customer_id\);`,
      },
      { type: 'contains', path: 'db/schema.sql', text: 'CREATE TABLE orders' },
    ],
    solution: [
      {
        path: 'db/schema.sql',
        content: `${SCHEMA}\nCREATE INDEX orders_customer_id_idx ON orders (customer_id);\n`,
      },
    ],
  }),
  task({
    id: 'db-03-money-minor-ar',
    category: 'database-architecture',
    locale: 'ar',
    title: 'المال بوحدات صغرى',
    prompt:
      'غيّر عمود المجموع في جدول orders من numeric(10,2) إلى total_minor bigint NOT NULL وأضف عمود currency char(3) NOT NULL. لا تستخدم أي عمود عشري.',
    fixture: DB,
    checks: [
      { type: 'contains', path: 'db/schema.sql', text: 'total_minor bigint NOT NULL' },
      { type: 'contains', path: 'db/schema.sql', text: 'currency char(3) NOT NULL' },
      {
        type: 'not_matches',
        path: 'db/schema.sql',
        pattern: String.raw`numeric|decimal|float|real`,
      },
    ],
    solution: [
      {
        path: 'db/schema.sql',
        content: L(
          'CREATE TABLE customers (',
          '  id uuid PRIMARY KEY,',
          '  name text NOT NULL',
          ');',
          '',
          'CREATE TABLE orders (',
          '  id uuid PRIMARY KEY,',
          '  customer_id uuid NOT NULL REFERENCES customers (id),',
          '  total_minor bigint NOT NULL,',
          '  currency char(3) NOT NULL',
          ');',
        ),
      },
    ],
  }),

  // ---- authentication and authorization
  task({
    id: 'auth-01-viewer-role',
    category: 'authentication',
    locale: 'en',
    title: 'A read-only role',
    prompt:
      "Add a 'viewer' role and can(role, action) in src/auth/roles.ts. admin may do everything, member may read and write, viewer may only read. Deny by default.",
    fixture: AUTH,
    checks: [
      { type: 'contains', path: 'src/auth/roles.ts', text: "'viewer'" },
      { type: 'contains', path: 'src/auth/roles.ts', text: 'export function can' },
      { type: 'matches', path: 'src/auth/roles.ts', pattern: String.raw`return false` },
    ],
    solution: [
      {
        path: 'src/auth/roles.ts',
        content: L(
          "export type Role = 'admin' | 'member' | 'viewer';",
          "export type Action = 'read' | 'write' | 'admin';",
          '',
          'export function can(role: Role, action: Action): boolean {',
          "  if (role === 'admin') return true;",
          "  if (role === 'member') return action === 'read' || action === 'write';",
          "  if (role === 'viewer') return action === 'read';",
          '  return false;',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'auth-02-expiry-boundary',
    category: 'authentication',
    locale: 'en',
    title: 'A session expires at its expiry instant',
    prompt:
      'isExpired treats a session as valid at the exact moment it expires. A session is expired at and after expiresAt: fix it.',
    fixture: AUTH,
    checks: [
      { type: 'matches', path: 'src/auth/session.ts', pattern: String.raw`expiresAt\s*<=\s*now` },
      {
        type: 'not_matches',
        path: 'src/auth/session.ts',
        pattern: String.raw`expiresAt\s*<\s*now`,
      },
    ],
    solution: [
      {
        path: 'src/auth/session.ts',
        content: SESSION.replace('s.expiresAt < now', 's.expiresAt <= now'),
      },
    ],
  }),
  task({
    id: 'auth-03-password-hash-ar',
    category: 'authentication',
    locale: 'ar',
    title: 'تجزئة كلمات المرور',
    prompt:
      'أنشئ src/auth/password.ts يحتوي على hashPassword(password) تستخدم scrypt من node:crypto مع ملح عشوائي من randomBytes وتعيد "الملح:التجزئة". لا تستخدم md5 ولا sha1.',
    fixture: AUTH,
    checks: [
      { type: 'contains', path: 'src/auth/password.ts', text: 'scryptSync' },
      { type: 'contains', path: 'src/auth/password.ts', text: 'randomBytes' },
      { type: 'not_matches', path: 'src/auth/password.ts', pattern: String.raw`md5|sha1` },
      { type: 'contains', path: 'src/auth/password.ts', text: 'export function hashPassword' },
    ],
    solution: [
      {
        path: 'src/auth/password.ts',
        content: L(
          "import { randomBytes, scryptSync } from 'node:crypto';",
          '',
          'export function hashPassword(password: string): string {',
          "  const salt = randomBytes(16).toString('hex');",
          "  const hash = scryptSync(password, salt, 64).toString('hex');",
          '  return `${salt}:${hash}`;',
          '}',
        ),
      },
    ],
  }),

  // ---- multi-file refactoring
  task({
    id: 'refac-01-reuse-helper',
    category: 'multi-file-refactoring',
    locale: 'en',
    title: 'Reuse the shared helper',
    prompt:
      'emailLabel duplicates the logic of fullName. Make email.ts import and use fullName from ./format; the output must stay the same.',
    fixture: REFAC,
    mustCall: ['read_file'],
    checks: [
      { type: 'contains', path: 'src/user/email.ts', text: "import { fullName } from './format';" },
      { type: 'not_contains', path: 'src/user/email.ts', text: "first + ' ' + last" },
      { type: 'contains', path: 'src/user/email.ts', text: 'fullName(first, last)' },
    ],
    solution: [
      {
        path: 'src/user/email.ts',
        content: L(
          "import { fullName } from './format';",
          '',
          'export function emailLabel(first: string, last: string, email: string): string {',
          "  return fullName(first, last) + ' <' + email + '>';",
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'refac-02-rename',
    category: 'multi-file-refactoring',
    locale: 'en',
    title: 'Rename across files',
    prompt:
      'Rename fullName to displayName everywhere it is declared or used. Nothing may still mention fullName.',
    fixture: REFAC,
    checks: [
      { type: 'contains', path: 'src/user/format.ts', text: 'export function displayName' },
      { type: 'not_contains', path: 'src/user/format.ts', text: 'fullName' },
      {
        type: 'contains',
        path: 'src/user/card.ts',
        text: "import { displayName } from './format';",
      },
      { type: 'not_contains', path: 'src/user/card.ts', text: 'fullName' },
    ],
    solution: [
      { path: 'src/user/format.ts', content: FORMAT.replace('fullName', 'displayName') },
      { path: 'src/user/card.ts', content: CARD.replaceAll('fullName', 'displayName') },
    ],
  }),
  task({
    id: 'refac-03-move-ar',
    category: 'multi-file-refactoring',
    locale: 'ar',
    title: 'نقل دالة إلى وحدة مشتركة',
    prompt:
      "انقل fullName إلى ملف جديد src/shared/name.ts، واجعل src/user/format.ts يعيد تصديرها من هناك (export { fullName } from '../shared/name';) حتى لا يتغير أي مستورد.",
    fixture: REFAC,
    checks: [
      { type: 'file_exists', path: 'src/shared/name.ts' },
      { type: 'contains', path: 'src/shared/name.ts', text: 'export function fullName' },
      {
        type: 'contains',
        path: 'src/user/format.ts',
        text: "export { fullName } from '../shared/name';",
      },
      { type: 'not_contains', path: 'src/user/format.ts', text: 'export function' },
    ],
    solution: [
      { path: 'src/shared/name.ts', content: FORMAT },
      { path: 'src/user/format.ts', content: L("export { fullName } from '../shared/name';") },
    ],
  }),

  // ---- bug fixing
  task({
    id: 'bug-02-empty-average',
    category: 'bug-fixing',
    locale: 'en',
    title: 'Average of nothing',
    prompt: 'average([]) returns NaN. It must return 0 for an empty list.',
    fixture: [
      f(
        'src/stats.ts',
        L(
          'export function average(xs: number[]): number {',
          '  return xs.reduce((a, b) => a + b, 0) / xs.length;',
          '}',
        ),
      ),
    ],
    checks: [
      { type: 'matches', path: 'src/stats.ts', pattern: String.raw`length === 0` },
      { type: 'contains', path: 'src/stats.ts', text: 'reduce' },
    ],
    solution: [
      {
        path: 'src/stats.ts',
        content: L(
          'export function average(xs: number[]): number {',
          '  if (xs.length === 0) return 0;',
          '  return xs.reduce((a, b) => a + b, 0) / xs.length;',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'bug-03-slug-spaces',
    category: 'bug-fixing',
    locale: 'en',
    title: 'Slugify only replaces the first space',
    prompt:
      'slugify("a b c") returns "a-b c". Every run of whitespace must become a single hyphen.',
    fixture: [
      f(
        'src/slug.ts',
        L(
          'export function slugify(s: string): string {',
          "  return s.toLowerCase().replace(' ', '-');",
          '}',
        ),
      ),
    ],
    checks: [
      { type: 'matches', path: 'src/slug.ts', pattern: String.raw`replace\(/\\s\+/g,\s*'-'\)` },
    ],
    solution: [
      {
        path: 'src/slug.ts',
        content: L(
          'export function slugify(s: string): string {',
          "  return s.toLowerCase().replace(/\\s+/g, '-');",
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'bug-04-missing-await-ar',
    category: 'bug-fixing',
    locale: 'ar',
    title: 'انتظار مفقود يتجاوز معالجة الخطأ',
    prompt: 'الدالة firstOk لا تلتقط رفض الوعد لأن return t() لا تنتظر النتيجة داخل try. أصلح ذلك.',
    fixture: [
      f(
        'src/retry.ts',
        L(
          'export async function firstOk<T>(tasks: (() => Promise<T>)[]): Promise<T> {',
          '  for (const t of tasks) {',
          '    try {',
          '      return t();',
          '    } catch {',
          '      continue;',
          '    }',
          '  }',
          "  throw new Error('all failed');",
          '}',
        ),
      ),
    ],
    checks: [
      { type: 'contains', path: 'src/retry.ts', text: 'return await t();' },
      { type: 'contains', path: 'src/retry.ts', text: 'continue;' },
    ],
    solution: [
      {
        path: 'src/retry.ts',
        content: L(
          'export async function firstOk<T>(tasks: (() => Promise<T>)[]): Promise<T> {',
          '  for (const t of tasks) {',
          '    try {',
          '      return await t();',
          '    } catch {',
          '      continue;',
          '    }',
          '  }',
          "  throw new Error('all failed');",
          '}',
        ),
      },
    ],
  }),

  // ---- security remediation
  task({
    id: 'sec-01-sql-injection',
    category: 'security-remediation',
    locale: 'en',
    title: 'Remove an SQL injection',
    prompt:
      'userQuery builds SQL by concatenating the email. Return a parameterized query { text, values } instead, with a $1 placeholder.',
    fixture: [
      f(
        'src/db/users.ts',
        L(
          'export function userQuery(email: string): string {',
          `  return "SELECT id, name FROM users WHERE email = '" + email + "'";`,
          '}',
        ),
      ),
    ],
    checks: [
      { type: 'contains', path: 'src/db/users.ts', text: '$1' },
      { type: 'matches', path: 'src/db/users.ts', pattern: String.raw`values:\s*\[email\]` },
      { type: 'not_matches', path: 'src/db/users.ts', pattern: String.raw`\+\s*email` },
    ],
    solution: [
      {
        path: 'src/db/users.ts',
        content: L(
          'export interface Query {',
          '  text: string;',
          '  values: string[];',
          '}',
          '',
          'export function userQuery(email: string): Query {',
          "  return { text: 'SELECT id, name FROM users WHERE email = $1', values: [email] };",
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'sec-02-xss',
    category: 'security-remediation',
    locale: 'en',
    title: 'Remove a DOM injection',
    prompt:
      'render writes user text with innerHTML. Write it as text instead so markup in the text is not interpreted.',
    fixture: [
      f(
        'src/ui/render.ts',
        L(
          'export function render(el: HTMLElement, text: string): void {',
          '  el.innerHTML = text;',
          '}',
        ),
      ),
    ],
    checks: [
      { type: 'contains', path: 'src/ui/render.ts', text: 'el.textContent = text;' },
      { type: 'not_contains', path: 'src/ui/render.ts', text: 'innerHTML' },
    ],
    solution: [
      {
        path: 'src/ui/render.ts',
        content: L(
          'export function render(el: HTMLElement, text: string): void {',
          '  el.textContent = text;',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'sec-03-hardcoded-token-ar',
    category: 'security-remediation',
    locale: 'ar',
    title: 'إزالة رمز مكتوب داخل الشيفرة',
    prompt:
      'الملف src/config.ts يحتوي على رمز خدمة مكتوب مباشرة. اجعله يُقرأ من متغير البيئة SERVICE_TOKEN ولا تُبقِ القيمة القديمة في الملف.',
    fixture: [f('src/config.ts', L("export const serviceToken = 'demo-token-value';"))],
    checks: [
      { type: 'contains', path: 'src/config.ts', text: 'process.env.SERVICE_TOKEN' },
      { type: 'not_contains', path: 'src/config.ts', text: 'demo-token-value' },
    ],
    solution: [
      {
        path: 'src/config.ts',
        content: L("export const serviceToken = process.env.SERVICE_TOKEN ?? '';"),
      },
    ],
  }),
  task({
    id: 'sec-04-weak-hash',
    category: 'security-remediation',
    locale: 'en',
    title: 'Replace a weak hash',
    prompt: 'checksum uses md5. Use sha256 from node:crypto instead and keep the hex output.',
    fixture: [
      f(
        'src/checksum.ts',
        L(
          "import { createHash } from 'node:crypto';",
          '',
          'export function checksum(data: string): string {',
          "  return createHash('md5').update(data).digest('hex');",
          '}',
        ),
      ),
    ],
    checks: [
      { type: 'contains', path: 'src/checksum.ts', text: "createHash('sha256')" },
      { type: 'not_contains', path: 'src/checksum.ts', text: 'md5' },
      { type: 'contains', path: 'src/checksum.ts', text: "digest('hex')" },
    ],
    solution: [
      {
        path: 'src/checksum.ts',
        content: L(
          "import { createHash } from 'node:crypto';",
          '',
          'export function checksum(data: string): string {',
          "  return createHash('sha256').update(data).digest('hex');",
          '}',
        ),
      },
    ],
  }),

  // ---- build and deployment planning
  task({
    id: 'bd-01-typecheck-script',
    category: 'build-deployment-planning',
    locale: 'en',
    title: 'Add a typecheck script',
    prompt:
      'Add a "typecheck" script running "tsc --noEmit" to package.json and keep the existing scripts.',
    fixture: BUILD,
    checks: [
      { type: 'json_valid', path: 'package.json' },
      {
        type: 'json_field_equals',
        path: 'package.json',
        field: 'scripts.typecheck',
        value: 'tsc --noEmit',
      },
      {
        type: 'json_field_equals',
        path: 'package.json',
        field: 'scripts.build',
        value: 'tsc -p tsconfig.json',
      },
    ],
    solution: [
      {
        path: 'package.json',
        content: PKG({
          build: 'tsc -p tsconfig.json',
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        }),
      },
    ],
  }),
  task({
    id: 'bd-02-deploy-plan',
    category: 'build-deployment-planning',
    locale: 'en',
    title: 'Write a deployment plan',
    prompt:
      'Create docs/deploy-plan.md with three sections: "## Build", "## Rollback" and "## Health check". Do not include any secret or real host name.',
    fixture: BUILD,
    checks: [
      { type: 'file_exists', path: 'docs/deploy-plan.md' },
      { type: 'contains', path: 'docs/deploy-plan.md', text: '## Build' },
      { type: 'contains', path: 'docs/deploy-plan.md', text: '## Rollback' },
      { type: 'contains', path: 'docs/deploy-plan.md', text: '## Health check' },
    ],
    solution: [
      {
        path: 'docs/deploy-plan.md',
        content: L(
          '# Deploy plan',
          '',
          '## Build',
          'Run the build script and keep the artifact.',
          '',
          '## Rollback',
          'Redeploy the previous artifact.',
          '',
          '## Health check',
          'Call the health endpoint after the deploy and compare the version.',
        ),
      },
    ],
  }),
  task({
    id: 'bd-03-dockerfile',
    category: 'build-deployment-planning',
    locale: 'en',
    title: 'A Dockerfile that does not run as root',
    prompt:
      'Create a Dockerfile for the Node app: node:22-slim base, copy the project, run the build script, start with node dist/index.js and run as the unprivileged user "node".',
    fixture: BUILD,
    checks: [
      { type: 'file_exists', path: 'Dockerfile' },
      { type: 'contains', path: 'Dockerfile', text: 'FROM node:22-slim' },
      { type: 'contains', path: 'Dockerfile', text: 'USER node' },
      { type: 'contains', path: 'Dockerfile', text: 'dist/index.js' },
      { type: 'not_matches', path: 'Dockerfile', pattern: String.raw`:latest` },
    ],
    solution: [
      {
        path: 'Dockerfile',
        content: L(
          'FROM node:22-slim',
          'WORKDIR /app',
          'COPY . .',
          'RUN npm run build',
          'USER node',
          'CMD ["node", "dist/index.js"]',
        ),
      },
    ],
  }),
  task({
    id: 'bd-04-env-doc-ar',
    category: 'build-deployment-planning',
    locale: 'ar',
    title: 'توثيق متغيرات البيئة دون قيم',
    prompt:
      'أنشئ docs/environment.md يسرد أسماء متغيرات البيئة المطلوبة DATABASE_URL وREDIS_URL وSERVICE_TOKEN مع وصف كل منها. لا تكتب أي قيمة حقيقية أو عنوان اتصال.',
    fixture: BUILD,
    checks: [
      { type: 'file_exists', path: 'docs/environment.md' },
      { type: 'contains', path: 'docs/environment.md', text: 'DATABASE_URL' },
      { type: 'contains', path: 'docs/environment.md', text: 'REDIS_URL' },
      { type: 'contains', path: 'docs/environment.md', text: 'SERVICE_TOKEN' },
      { type: 'not_matches', path: 'docs/environment.md', pattern: String.raw`://` },
    ],
    solution: [
      {
        path: 'docs/environment.md',
        content: L(
          '# متغيرات البيئة',
          '',
          '- DATABASE_URL: عنوان الاتصال بقاعدة البيانات، يُحقن من المخزن السري.',
          '- REDIS_URL: عنوان الاتصال بالذاكرة المؤقتة.',
          '- SERVICE_TOKEN: رمز الخدمة، يُحقن من المخزن السري.',
        ),
      },
    ],
  }),
];
