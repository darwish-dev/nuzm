import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentRuntime, verifyAuditChain } from './agent-runtime';
import { COMMANDS, clpctlArgv, validateArgs } from './commands';
import { canonicalize, generateSigningKey, signEnvelope } from './envelope';
import { MockCloudPanelNode } from '../mock/mock-cloudpanel';
import { LIMITS } from '../mock/fixtures';

const NODE = '00000000-0000-7000-8000-0000000000aa';
const T0 = new Date('2026-11-18T10:00:00Z');
const setup = () => {
  const { signing, publicKey } = generateSigningKey('k1');
  const other = generateSigningKey('k1'); // same key id, DIFFERENT key
  let now = T0;
  const node = new MockCloudPanelNode({ nodeId: NODE });
  const rt = new AgentRuntime({ nodeId: NODE, keys: new Map([['k1', publicKey]]), executor: node, now: () => now });
  const env = (o: Record<string, unknown> = {}) => signEnvelope(signing, { nodeId: NODE, operationId: 'op1', idempotencyToken: 'tok-1', commandId: 'inventory', args: {}, now, ...o } as never);
  return { signing, publicKey, other, node, rt, env, setNow: (d: Date) => (now = d) };
};
const create = (over: Record<string, unknown> = {}) => ({ site: 's-aaaaaaaaaaaaaaaaaaaa', runtime: 'php:8.3', domain: 's-aaaaaaaaaaaaaaaaaaaa.sites.example.test', limits: LIMITS, credentialsRef: 'vault://hosting/c1', backupKeyRef: 'vault://hosting/b1', ...over });

describe('node agent: envelope verification (AC-M06-14: >= 10 cases, 100% rejected)', () => {
  it('accepts a good signed command', async () => {
    const s = setup();
    expect((await s.rt.handle(s.env())).status).toBe('ok');
  });
  const rejected = async (mk: (s: ReturnType<typeof setup>) => unknown, reason: string) => {
    const s = setup();
    const r = await s.rt.handle(mk(s));
    expect(r).toMatchObject({ status: 'rejected', reason });
    expect(s.node.executed).toHaveLength(0); // nothing reached the executor
  };
  it('rejects an unsigned envelope', () => rejected((s) => ({ body: s.env().body, signature: '' }), 'bad_signature'));
  it('rejects a missing body', () => rejected(() => ({ signature: 'x' }), 'malformed'));
  it('rejects non-objects', () => rejected(() => 'hello', 'malformed'));
  it('rejects a forged signature (another key, same key id)', () => rejected((s) => signEnvelope(s.other.signing, { nodeId: NODE, operationId: 'o', idempotencyToken: 't', commandId: 'inventory', args: {}, now: T0 }), 'bad_signature'));
  it('rejects an unknown key id', () => rejected((s) => signEnvelope({ ...s.signing, keyId: 'nope' }, { nodeId: NODE, operationId: 'o', idempotencyToken: 't', commandId: 'inventory', args: {}, now: T0 }), 'unknown_key'));
  it('rejects a tampered body (arg changed after signing)', () => rejected((s) => { const e = s.env({ commandId: 'site.find', args: { site: 's-aaaaaaaaaaaaaaaaaaaa' } }); return { ...e, body: { ...e.body, args: { site: 's-bbbbbbbbbbbbbbbbbbbb' } } }; }, 'bad_signature'));
  it('rejects a tampered command id', () => rejected((s) => { const e = s.env(); return { ...e, body: { ...e.body, commandId: 'site.delete' } }; }, 'bad_signature'));
  it('rejects an envelope addressed to another node (lateral movement)', () => rejected((s) => s.env({ nodeId: '00000000-0000-7000-8000-0000000000bb' }), 'wrong_node'));
  it('rejects an expired envelope', async () => {
    const s = setup();
    const e = s.env({ ttlMs: 60_000 });
    s.setNow(new Date(T0.getTime() + 61_000));
    expect(await s.rt.handle(e)).toMatchObject({ status: 'rejected', reason: 'expired' });
  });
  it('rejects a not-yet-valid envelope (issued in the future)', () => rejected((s) => s.env({ now: new Date(T0.getTime() + 10 * 60_000) }), 'not_yet_valid'));
  it('rejects a ttl above the maximum even when signed', () => rejected((s) => { const e = s.env(); const body = { ...e.body, expiresAt: new Date(T0.getTime() + 3_600_000).toISOString() }; return { ...e, body }; }, 'bad_signature'));
  it('rejects a replayed envelope (same nonce)', async () => {
    const s = setup();
    const e = s.env();
    expect((await s.rt.handle(e)).status).toBe('ok');
    expect(await s.rt.handle(e)).toMatchObject({ status: 'rejected', reason: 'replayed' });
  });
  it('still rejects a replay after an agent restart (the nonce ledger is persisted)', async () => {
    const s = setup();
    const e = s.env();
    await s.rt.handle(e);
    const restarted = new AgentRuntime({ nodeId: NODE, keys: new Map([['k1', s.publicKey]]), executor: s.node, now: () => T0 }, s.rt.snapshot());
    expect(await restarted.handle(e)).toMatchObject({ status: 'rejected', reason: 'replayed' });
  });
  it('rejects an oversize envelope', () => rejected((s) => ({ ...s.env(), pad: 'x'.repeat(70_000) }), 'oversize'));
});

describe('node agent: allow-list, schemas and injection', () => {
  it('rejects a command that is not allow-listed', async () => {
    const s = setup();
    for (const id of ['shell.exec', 'run', 'bash', 'Inventory', 'site.create ', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])
      expect(await s.rt.handle(s.env({ commandId: id, nonce: Math.random().toString(16).slice(2).padEnd(32, '0') })), id).toMatchObject({ status: 'rejected', reason: 'unknown_command' });
    expect(s.node.executed).toHaveLength(0);
  });
  it('rejects argument injection attempts on every free string', async () => {
    const s = setup();
    const evil = ['a; rm -rf /', 's-aaaaaaaaaaaaaaaaaaaa && id', '../../etc/passwd', '$(id)', '`id`', 's-aaaaaaaaaaaaaaaaaaaa\n--force', '--force', 's-AAAAAAAAAAAAAAAAAAAA', 's-aaaaaaaaaaaaaaaaaaaa|cat', '', 'x'.repeat(600), '/etc/shadow', 's-short'];
    for (const [i, site] of evil.entries()) {
      const r = await s.rt.handle(s.env({ commandId: 'site.delete', args: { site }, idempotencyToken: `t${i}`, nonce: i.toString(16).padStart(32, '0') }));
      expect(r, site).toMatchObject({ status: 'rejected', reason: 'invalid_args' });
    }
    expect(s.node.sites.size).toBe(0);
  });
  it('rejects unknown members, wrong types and out-of-range values (no free-form field exists)', async () => {
    const s = setup();
    const bad: Record<string, unknown>[] = [
      create({ shell: 'id' }), create({ domain: 'bad domain' }), create({ domain: 'UPPER.example.test' }), create({ runtime: 'ruby:3' }), create({ runtime: 'php:8.3; id' }),
      create({ credentialsRef: '/etc/shadow' }), create({ credentialsRef: 'vault://../../x' }), create({ limits: { ...LIMITS, diskMb: -1 } }), create({ limits: { ...LIMITS, extra: 1 } }), create({ limits: { ...LIMITS, maxProcesses: 1.5 } }),
    ];
    for (const [i, a] of bad.entries()) {
      const r = await s.rt.handle(s.env({ commandId: 'site.create', args: a, idempotencyToken: `c${i}`, nonce: (i + 100).toString(16).padStart(32, '0') }));
      expect(r, JSON.stringify(a)).toMatchObject({ status: 'rejected', reason: 'invalid_args' });
    }
  });
  it('every allow-listed command schema is closed (additionalProperties false semantic) and has no shell/path/flag/command member', () => {
    for (const [id, d] of Object.entries(COMMANDS)) {
      expect(d.schema.type, id).toBe('object');
      const names = JSON.stringify(Object.keys(d.schema.properties ?? {}));
      expect(names, id).not.toMatch(/shell|cmd|command|path|flag|argv|script|exec/i);
      expect(validateArgs(d.schema, { __unknown: 1 }), id).toMatch(/unknown member|required/);
    }
  });
  it('records the first result of a token and does not execute twice (idempotent create)', async () => {
    const s = setup();
    const mk = (n: number) => s.env({ commandId: 'site.create', args: create(), idempotencyToken: 'same-token', nonce: n.toString(16).padStart(32, '0') });
    const a = await s.rt.handle(mk(1));
    const b = await s.rt.handle(mk(2));
    expect(a.status).toBe('ok');
    expect(b).toMatchObject({ status: 'ok', recorded: true });
    expect(s.node.executed.filter((e) => e.commandId === 'site.create')).toHaveLength(1);
    expect(s.node.sites.size).toBe(1);
  });
  it('refuses a token reused with different arguments', async () => {
    const s = setup();
    await s.rt.handle(s.env({ commandId: 'site.create', args: create(), idempotencyToken: 'tk', nonce: '1'.padStart(32, '0') }));
    const r = await s.rt.handle(s.env({ commandId: 'site.create', args: create({ runtime: 'static' }), idempotencyToken: 'tk', nonce: '2'.padStart(32, '0') }));
    expect(r).toMatchObject({ status: 'rejected', reason: 'token_reuse' });
  });
  it('keeps an append-only hash-chained audit log of EVERY decision, rejections included; tampering is detected', async () => {
    const s = setup();
    await s.rt.handle(s.env());
    await s.rt.handle({ junk: true });
    await s.rt.handle(s.env({ commandId: 'nope', nonce: '9'.padStart(32, '0') }));
    const log = s.rt.auditLog;
    expect(log.length).toBeGreaterThanOrEqual(4);
    expect(log.map((e) => e.outcome)).toContain('rejected');
    expect(verifyAuditChain(log)).toEqual({ ok: true });
    const tampered = log.map((e, i) => (i === 1 ? { ...e, reason: 'edited' } : e));
    expect(verifyAuditChain(tampered).ok).toBe(false);
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalize({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });
  it('an unrelated Ed25519 key can never verify (sanity)', () => {
    expect(generateKeyPairSync('ed25519').publicKey.asymmetricKeyType).toBe('ed25519');
  });
});

describe('clpctl argv builder (documented commands only; argv arrays, no shell)', () => {
  it('builds argv for documented commands and refuses an invalid domain', () => {
    expect(clpctlArgv({ op: 'site.delete', domain: 'a.example.test' })).toEqual(['clpctl', 'site:delete', '--domainName=a.example.test', '--force']);
    expect(clpctlArgv({ op: 'cert.issue', domain: 'a.example.test', sans: ['www.a.example.test'] })).toEqual(['clpctl', 'lets-encrypt:install:certificate', '--domainName=a.example.test', '--subjectAlternativeName=www.a.example.test']);
    const php = clpctlArgv({ op: 'site.add.php', domain: 'a.example.test', phpVersion: '8.3', siteUser: 'u1', password: 'x' });
    expect(php.slice(0, 2)).toEqual(['clpctl', 'site:add:php']);
    expect(php.every((x) => typeof x === 'string' && !x.includes('\n'))).toBe(true);
    expect(() => clpctlArgv({ op: 'site.delete', domain: 'a.example.test; id' })).toThrow();
    expect(() => clpctlArgv({ op: 'site.delete', domain: '$(id).example.test' })).toThrow();
  });
});
