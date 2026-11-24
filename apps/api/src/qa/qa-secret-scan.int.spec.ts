import { describe, expect, it } from 'vitest';
import { scanForSecrets } from '@nuzm/domain';

/**
 * Session 07 (QA), Phase 2 - the outbound secret scanner (`packages/domain/src/ai/secret-scan.ts`) against the secret shapes that really appear in the files and
 * pastes a customer's project carries (.env files, JSON config, provider keys, connection strings, key blocks). It is the control that stops a credential from being
 * sent to a model provider (gateway, builder agent) and from being kept in build logs (mobile build log redaction). No DB, no network. Every "secret" below is
 * ASSEMBLED from fragments at run time and is not a credential: the repository secret scan stays green and nothing real is embedded.
 *
 * `it.fails` marks DEFECT-9 (owner: Session 02 / Master `packages/domain/src/ai/secret-scan.ts`): the test states the SECURE expectation and fails today.
 */
const j = (...p: string[]) => p.join('');
const rnd = (n: number, seed = 'Ab3dE5gH7jK9mN1pQ3sT5vX7zC2fR4uW8yB6') =>
  seed.repeat(3).slice(0, n);

/** secrets the scanner must catch */
const DETECTED_TODAY: [string, string][] = [
  ['private key block', `-----BEGIN ${'RSA'} PRIVATE KEY-----\nMIIE...`],
  ['OpenSSH private key block', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`],
  ['AWS access key id', j('AKIA', 'ABCDEFGHIJKLMNOP')],
  ['Nuzm API key', j('nzk_', 'abcdefgh', '_', rnd(24))],
  ['vault reference', j('vault', '://', 'org/ai/key')],
  ['bearer token', j('Authorization: Bearer ', rnd(32))],
  [
    'JWT',
    j(
      'eyJ',
      'hbGciOiJIUzI1NiJ9',
      '.',
      'eyJ',
      'zdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'SflKxwRJSMeKKF2QT4fw',
    ),
  ],
  ['GitHub token', j('ghp', '_', rnd(36))],
  ['Slack token', j('xoxb', '-', '123456789012-', rnd(20))],
  ['assignment: api_key = value', j('api_key = "', rnd(32), '"')],
  ['assignment: password: value', j('password: ', rnd(20))],
  ['postgres connection string', j('postgres', '://app:', 'pw1234secret', '@db.internal:5432/app')],
  ['sealed field', j('enc:v1:', 'k1:', rnd(60))],
];

/** secrets that pass today: DEFECT-9 */
const MISSED_TODAY: [string, string][] = [
  [
    '.env: prefixed secret key (STRIPE_SECRET_KEY=sk_live_…)',
    j('STRIPE_SECRET_KEY=', 'sk_', 'live_', rnd(28)),
  ],
  [
    '.env: AWS_SECRET_ACCESS_KEY=…',
    j('AWS_SECRET_ACCESS_KEY=', 'wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'),
  ],
  ['.env: SESSION_SECRET=…', j('SESSION_SECRET=', rnd(40))],
  ['.env: JWT_SECRET=…', j('JWT_SECRET=', rnd(40))],
  ['.env: ACCESS_TOKEN=…', j('ACCESS_TOKEN=', rnd(40))],
  ['JSON config: "password": "…"', j('{"password": "', rnd(24), '"}')],
  ['JSON config: "apiKey": "…"', j('{"apiKey": "', rnd(32), '"}')],
  ['JSON config: "client_secret": "…"', j('{"client_secret": "', rnd(32), '"}')],
  ['provider key: Anthropic style (sk-ant-…)', j('sk-', 'ant-', 'api03-', rnd(40))],
  ['provider key: OpenAI style (sk-proj-…)', j('sk-', 'proj-', rnd(40))],
  ['provider key: Google API key (AIza…)', j('AI', 'za', rnd(35))],
  ['provider key: Stripe live key alone', j('sk_', 'live_', rnd(28))],
  ['YAML: secret on its own line', j('client_secret:\n  ', rnd(32))],
];

describe('QA secret scan: what is caught today (must keep passing)', () => {
  for (const [name, text] of DETECTED_TODAY)
    it(`${name}`, () => {
      expect(scanForSecrets(`context line\n${text}\nanother line`).length, name).toBeGreaterThan(0);
    });
  it('the finding carries the KIND and an offset, never the matched value', () => {
    const secret = j('ghp', '_', rnd(36));
    const f = scanForSecrets(`token is ${secret}`);
    expect(JSON.stringify(f)).not.toContain(secret);
    expect(f[0]).toMatchObject({ kind: 'github_token' });
  });
  it('canaries match exactly and a short canary is ignored; ordinary prose and code are not findings', () => {
    expect(
      scanForSecrets('x CANARY-PLATFORM-SECRET-0001 y', ['CANARY-PLATFORM-SECRET-0001']).length,
    ).toBe(1);
    expect(
      scanForSecrets('the word secret appears here and a password policy is described', []).length,
    ).toBe(0);
    expect(
      scanForSecrets(
        'const total = items.reduce((n, i) => n + i.price, 0); // 12345678901234567890',
        [],
      ).length,
    ).toBe(0);
  });
});

describe('QA secret scan: former gaps (DEFECT-9, fixed by the Master)', () => {
  for (const [name, text] of MISSED_TODAY)
    it(`DEFECT-9 (fixed): ${name} is detected`, () => {
      expect(scanForSecrets(`context line\n${text}\nanother line`).length, name).toBeGreaterThan(0);
    });
});

describe('QA secret scan: false-positive controls after the DEFECT-9 fix (ordinary code and prose are not findings)', () => {
  const OK = [
    'const token = getToken(session);',
    'const secret = process.env.JWT_SECRET_VALUE_FROM_ENV;',
    'password: ${DB_PASSWORD_FROM_COMPOSE_FILE}',
    'JWT_SECRET=${JWT_SECRET_FROM_VAULT_INJECTION}',
    'tokenizer = createTokenizer()',
    'the secretary sends a password reset notice: see the docs',
    'export const apiKeyHeader = "x-api-key";',
    'if (!token) throw new Error("missing token");',
  ];
  for (const text of OK)
    it(`no finding: ${text.slice(0, 50)}`, () => {
      expect(scanForSecrets(text, []), text).toEqual([]);
    });
});
